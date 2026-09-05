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
