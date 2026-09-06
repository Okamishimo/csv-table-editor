"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const iconv = require("iconv-lite");

const {
  CsvStreamPager,
  SEARCH_MATCH_LIMIT,
  searchLargeFile,
} = require("../src/large-file-mode");

const encodingApi = {
  decode: (bytes, key) => iconv.decode(Buffer.from(bytes), key),
  createDecoder: (key) => iconv.getDecoder(key),
};

/** A document standing in for the pager: fixed pages, addressed by number. */
function fakeDocument(pageCount, { rowsPerPage = 3, value = (row) => `v${row}` } = {}) {
  const reads = [];
  return {
    reads,
    async pageAt(pageNumber) {
      if (pageNumber < 1 || pageNumber > pageCount) return null;
      reads.push(pageNumber);
      const startRow = 2 + (pageNumber - 1) * rowsPerPage;
      const rows = [];
      for (let index = 0; index < rowsPerPage; index++) {
        const row = startRow + index;
        rows.push([String(row), value(row), "tail"]);
      }
      return {
        header: ["id", "name", "note"],
        rows,
        pageNumber,
        startRow,
        endRow: startRow + rowsPerPage - 1,
        done: pageNumber === pageCount,
      };
    },
  };
}

/** Run a scan to completion, returning every reported match in order. */
async function scan(document, request, options = {}) {
  const reports = [];
  await searchLargeFile(document, request, {
    serialize: (task) => task(),
    cancelled: options.cancelled || (() => false),
    report: (update) => reports.push(update),
  });
  const matches = [];
  for (const report of reports) matches.push(...report.matches);
  return { matches, reports };
}

const positions = (matches) => matches.map((match) => `${match.r}:${match.c}`);

test("a scan reads the whole file and orders matches from the reader's position", async () => {
  // Rows 2..13 across four pages; "target" sits on rows 3, 6 and 11.
  const document = fakeDocument(4, {
    value: (row) => ([3, 6, 11].includes(row) ? "target" : `plain${row}`),
  });
  const { matches } = await scan(document, { query: "target", column: -1, fromRow: 6 });

  assert.deepEqual(positions(matches), ["6:1", "11:1", "3:1"],
    "matches at or after the start row come first, then the file wraps to the top");
  assert.deepEqual(document.reads, [1, 2, 3, 4], "every page is read exactly once");
});

test("a scan starting at the top never wraps and still covers the file", async () => {
  const document = fakeDocument(4, {
    value: (row) => ([3, 6, 11].includes(row) ? "target" : `plain${row}`),
  });
  const { matches } = await scan(document, { query: "target", column: -1, fromRow: 0 });
  assert.deepEqual(positions(matches), ["3:1", "6:1", "11:1"]);
});

test("a scan starting past the last match reports only the wrap", async () => {
  const document = fakeDocument(4, {
    value: (row) => ([3, 6].includes(row) ? "target" : `plain${row}`),
  });
  const { matches } = await scan(document, { query: "target", column: -1, fromRow: 12 });
  assert.deepEqual(positions(matches), ["3:1", "6:1"]);
});

test("a scan matches case-insensitively and honours a column scope", async () => {
  const document = fakeDocument(2, { value: (row) => (row === 4 ? "TarGet" : "target") });
  const unscoped = await scan(document, { query: "target", column: -1, fromRow: 0 });
  assert.equal(unscoped.matches.length, 6, "every row matches in the name column");

  // Column 0 holds row numbers and column 2 the literal "tail": neither matches.
  const scoped = await scan(document, { query: "target", column: 0, fromRow: 0 });
  assert.deepEqual(scoped.matches, []);

  const scopedToName = await scan(document, { query: "target", column: 1, fromRow: 0 });
  assert.deepEqual(positions(scopedToName.matches), ["2:1", "3:1", "4:1", "5:1", "6:1", "7:1"]);
});

test("a scan reports as it goes, so an early match is navigable before the end", async () => {
  const document = fakeDocument(400, {
    value: (row) => (row === 5 || row === 1000 ? "target" : "plain"),
  });
  const { reports } = await scan(document, { query: "target", column: -1, fromRow: 0 });

  assert.ok(reports.length > 1, "a long scan reports more than once");
  assert.equal(reports.at(-1).done, true);
  assert.equal(reports.filter((report) => report.done).length, 1, "exactly one final report");
  const firstWithMatch = reports.find((report) => report.matches.length);
  assert.equal(firstWithMatch.done, false, "the first match arrives before the scan finishes");
  assert.equal(firstWithMatch.matches[0].r, 5);
  assert.ok(firstWithMatch.scannedRows < 1200, "reported early, not after reading everything");
});

test("a cancelled scan stops reading and reports nothing further", async () => {
  const document = fakeDocument(500, { value: () => "target" });
  let calls = 0;
  const { reports } = await scan(document, { query: "target", column: -1, fromRow: 0 },
    { cancelled: () => ++calls > 4 });

  assert.ok(document.reads.length < 10, `a cancelled scan stops early, read ${document.reads.length} pages`);
  assert.equal(reports.some((report) => report.done), false, "no final report after cancelling");
});

test("a query matching most of the file is capped and says so", async () => {
  const document = fakeDocument(20000, { value: () => "target" });
  const { reports } = await scan(document, { query: "target", column: -1, fromRow: 0 });
  const final = reports.at(-1);

  assert.equal(final.done, true);
  assert.equal(final.truncated, true);
  assert.equal(final.total, SEARCH_MATCH_LIMIT);
  const collected = reports.reduce((sum, report) => sum + report.matches.length, 0);
  assert.ok(collected <= SEARCH_MATCH_LIMIT, `collected ${collected} positions`);
});

test("an empty query does no work at all", async () => {
  const document = fakeDocument(10);
  const { reports } = await scan(document, { query: "   ", column: -1, fromRow: 0 });
  assert.deepEqual(reports, []);
  assert.deepEqual(document.reads, []);
});

test("a scan over a real file finds every match and leaves its pages cached", async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "csv-table-editor-search-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "large.csv");
  const lines = ["id,name"];
  for (let index = 1; index <= 1000; index++) {
    lines.push(`${index},${index % 250 === 0 ? "needle" : "plain"} ${index}`);
  }
  await fs.promises.writeFile(filePath, lines.join("\n"));

  const pager = new CsvStreamPager(filePath, "utf8", ",", encodingApi);
  t.after(() => pager.close());
  // Read two pages first, the way a reader scrolling would.
  await pager.nextPage();
  await pager.nextPage();

  const document = { pageAt: (pageNumber) => pager.pageAt(pageNumber) };
  const { matches, reports } = await scan(document, { query: "needle", column: -1, fromRow: 302 });

  // The header is row 1, so the record with id N is row N+1: ids 250, 500, 750
  // and 1000 carry the needle, at rows 251, 501, 751 and 1001.
  assert.deepEqual(matches.map((match) => match.r), [501, 751, 1001, 251],
    "matches below the start row come first, then the file wraps");
  assert.equal(reports.at(-1).done, true);
  assert.equal(reports.at(-1).total, 4);
  assert.equal(reports.at(-1).truncated, false);

  // Every page the scan passed can now be served without re-reading the file.
  for (const match of matches) {
    const page = await pager.pageAt(match.p);
    assert.ok(page, `page ${match.p} must be cached`);
    assert.ok(match.r >= page.startRow && match.r <= page.endRow,
      `row ${match.r} must fall inside page ${match.p}`);
    assert.match(page.rows[match.r - page.startRow][match.c], /needle/);
  }
});

test("an indexed pager reaches any page directly, forwards or backwards", async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "csv-table-editor-seek-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "large.csv");
  const lines = ["id,name"];
  for (let index = 1; index <= 2000; index++) lines.push(`${index},"name, ${index}"`);
  await fs.promises.writeFile(filePath, lines.join("\n"));

  const { buildFileIndex } = require("../src/large-file-index");
  const pager = new CsvStreamPager(filePath, "utf8", ",", encodingApi);
  t.after(() => pager.close());
  const first = await pager.nextPage();
  assert.deepEqual(first.header, ["id", "name"]);

  // Without an index a page beyond the next one is out of reach.
  assert.equal(await pager.pageAt(15), null);

  pager.index = await buildFileIndex(filePath, "utf8", 100);
  assert.equal(pager.index.totalRows, 2000);

  // Jump far ahead, then far back, then to the very end.
  for (const [page, firstId] of [[15, 1401], [3, 201], [20, 1901], [1, 1], [11, 1001]]) {
    const loaded = await pager.pageAt(page);
    assert.ok(loaded, `page ${page} must be reachable`);
    assert.equal(loaded.pageNumber, page);
    assert.equal(loaded.startRow, (page - 1) * 100 + 2, `page ${page} row numbering`);
    assert.equal(loaded.rows.length, 100);
    assert.deepEqual(loaded.rows[0], [String(firstId), `name, ${firstId}`],
      `page ${page} must begin at record ${firstId}`);
    assert.deepEqual(loaded.header, ["id", "name"], "the header survives a seek");
  }

  // Scrolling on from a seeked position keeps working.
  const after = await pager.pageAt(12);
  assert.equal(after.rows[0][0], "1101");
  assert.equal(await pager.pageAt(21), null, "there is no page past the end");
});

test("a seek does not cache the same page twice", async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "csv-table-editor-seek2-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "large.csv");
  const lines = ["id,name"];
  for (let index = 1; index <= 500; index++) lines.push(`${index},name ${index}`);
  await fs.promises.writeFile(filePath, lines.join("\n"));

  const { buildFileIndex } = require("../src/large-file-index");
  const pager = new CsvStreamPager(filePath, "utf8", ",", encodingApi);
  t.after(() => pager.close());
  await pager.nextPage();
  pager.index = await buildFileIndex(filePath, "utf8", 100);

  await pager.pageAt(4);
  const cachedAfterSeek = pager.pageCache.size;
  const bytesAfterSeek = pager.pageCacheBytes;
  await pager.pageAt(4);
  await pager.pageAt(1);
  assert.equal(pager.pageCache.size, cachedAfterSeek, "re-reading a cached page stores nothing new");
  assert.equal(pager.pageCacheBytes, bytesAfterSeek);
});

test("the page cache stays bounded and an evicted page is still reachable", async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "csv-table-editor-cache-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "wide.csv");
  // Fat rows, so the byte limit bites long before the page limit.
  const padding = "x".repeat(2000);
  const lines = ["id,name"];
  for (let index = 1; index <= 40000; index++) lines.push(`${index},${padding}${index}`);
  await fs.promises.writeFile(filePath, lines.join("\n"));

  const { buildFileIndex } = require("../src/large-file-index");
  const { PAGE_CACHE_MAX_BYTES, PAGE_CACHE_MAX_PAGES } = require("../src/large-file-mode");
  const pager = new CsvStreamPager(filePath, "utf8", ",", encodingApi);
  t.after(() => pager.close());
  await pager.nextPage();
  pager.index = await buildFileIndex(filePath, "utf8", 100);

  // Read the whole file the way a search does.
  const document = { pageAt: (pageNumber) => pager.pageAt(pageNumber) };
  await scan(document, { query: "nothing-matches", column: -1, fromRow: 0 });

  assert.equal(pager.pageNumber, 400, "the scan reached the end");
  assert.ok(pager.pageCache.size < 400, `the cache is bounded, holds ${pager.pageCache.size} of 400 pages`);
  assert.ok(pager.pageCache.size <= PAGE_CACHE_MAX_PAGES);
  assert.ok(pager.pageCacheBytes <= PAGE_CACHE_MAX_BYTES + 1,
    `cache holds ${pager.pageCacheBytes} bytes, limit ${PAGE_CACHE_MAX_BYTES}`);
  assert.equal(pager.pageCache.has(1), false, "the first page was dropped long ago");

  // Dropped is not lost: the index makes it readable again.
  const first = await pager.pageAt(1);
  assert.ok(first, "an evicted page comes back from the file");
  assert.equal(first.startRow, 2);
  assert.deepEqual(first.rows[0], ["1", `${padding}1`]);
  assert.deepEqual(first.header, ["id", "name"]);
});

test("recently read pages survive and the oldest are the ones dropped", async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "csv-table-editor-lru-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "data.csv");
  const lines = ["id,name"];
  for (let index = 1; index <= 100000; index++) lines.push(`${index},name ${index}`);
  await fs.promises.writeFile(filePath, lines.join("\n"));

  const { buildFileIndex } = require("../src/large-file-index");
  const pager = new CsvStreamPager(filePath, "utf8", ",", encodingApi);
  t.after(() => pager.close());
  await pager.nextPage();
  pager.index = await buildFileIndex(filePath, "utf8", 100);

  // Fill past the page limit, touching page 2 as we go so it stays warm.
  for (let page = 2; page <= 700; page++) {
    await pager.pageAt(page);
    if (page % 50 === 0) await pager.pageAt(2);
  }
  assert.ok(pager.pageCache.size <= 512);
  assert.equal(pager.pageCache.has(2), true, "a page kept in use is kept in the cache");
  assert.equal(pager.pageCache.has(3), false, "one never touched again is not");
  assert.equal(pager.pageCache.has(700), true, "the newest page is there");
});

test("scrolling back past the cache reads the page again instead of giving up", async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "csv-table-editor-back-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "data.csv");
  const lines = ["id,name"];
  for (let index = 1; index <= 100000; index++) lines.push(`${index},name ${index}`);
  await fs.promises.writeFile(filePath, lines.join("\n"));

  const { buildFileIndex } = require("../src/large-file-index");
  const pager = new CsvStreamPager(filePath, "utf8", ",", encodingApi);
  t.after(() => pager.close());
  await pager.nextPage();
  pager.index = await buildFileIndex(filePath, "utf8", 100);
  for (let page = 2; page <= 700; page++) await pager.pageAt(page);

  assert.equal(pager.pageCache.has(2), false, "page 2 is long gone from the cache");
  const previous = await pager.previousPage(3);
  assert.ok(previous, "scrolling up still works");
  assert.equal(previous.pageNumber, 2);
  assert.equal(previous.startRow, 102);
  assert.deepEqual(previous.rows[0], ["101", "name 101"]);
});

test("preview search reads from the current page and stops at the first match", async () => {
  const document = fakeDocument(8, { value: (row) => [3, 9, 10, 12, 20].includes(row) ? "target" : "plain" });
  const { matches, reports } = await scan(document,
    { query: "target", fromRow: 10, fromPage: 3, firstOnly: true });
  assert.deepEqual(document.reads, [3], "no page before the reader or after the first match is read");
  assert.deepEqual(positions(matches), ["10:1"], "matches above the viewport on the same page are skipped");
  assert.equal(reports.at(-1).done, true);
  assert.equal(reports.at(-1).scannedRows, 1);
});

test("preview search continues downward across pages, honours scope, and does not wrap", async () => {
  const document = fakeDocument(5, { value: (row) => [3, 15].includes(row) ? "target" : "plain" });
  const request = { query: "target", fromRow: 10, fromPage: 3, firstOnly: true, column: 1 };
  const { matches } = await scan(document, request);
  assert.deepEqual(document.reads, [3, 4, 5]);
  assert.deepEqual(positions(matches), ["15:1"]);
  document.reads.length = 0;
  const scoped = await scan(document, { ...request, column: 0 });
  assert.equal(scoped.matches.length, 0);
  assert.deepEqual(document.reads, [3, 4, 5]);
  const noWrap = await scan(document, { ...request, fromRow: 16, fromPage: 5 });
  assert.equal(noWrap.matches.length, 0);
});

test("a cancelled first-match search emits nothing after an in-flight read", async () => {
  const document = fakeDocument(3, { value: () => "target" });
  let cancelled = false;
  const read = document.pageAt;
  document.pageAt = async (page) => { const value = await read(page); cancelled = true; return value; };
  const { reports } = await scan(document, { query: "target", fromPage: 2, firstOnly: true }, { cancelled: () => cancelled });
  assert.deepEqual(reports, []);
  assert.deepEqual(document.reads, [2]);
});
