"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const iconv = require("iconv-lite");

const { buildFileIndex } = require("../src/large-file-index");
const { StreamingCsvParser } = require("../src/large-file-mode");

const PAGE_ROWS = 100;

async function withFile(t, bytes, run) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "csv-table-editor-index-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "data.csv");
  await fs.promises.writeFile(filePath, bytes);
  return run(filePath);
}

/** The record count the preview's own parser would produce for the same text. */
function parserRecordCount(text) {
  const parser = new StreamingCsvParser(",");
  // Feed it in awkward pieces so chunk boundaries are exercised too.
  for (let index = 0; index < text.length; index += 7) parser.push(text.slice(index, index + 7));
  parser.finish();
  return parser.rows.length;
}

const TRICKY = [
  "",
  "a",
  "a\n",
  "a\r\n",
  "a\rb",
  "a\n\n",
  "h1,h2\nx,y\n",
  "h1,h2\nx,y",
  'h,"quoted"\n"line\nbreak",2\n',
  '"a""b",c\n1,2\n',
  '"unterminated,1\n2,3',
  'a,"b\r\nc",d\ne,f,g\n',
  '"",""\n"",""\n',
  'x\n"y"\n',
  '"a"\n',
  '"a"b\nc\n',
  "\n",
  "\r\n",
  "\r",
  "\n\n\n",
  'a,b\r\n"c\rd",e\r\n',
];

test("the index counts exactly the records the preview's parser produces", async (t) => {
  for (const text of TRICKY) {
    await withFile(t, Buffer.from(text, "utf8"), async (filePath) => {
      const index = await buildFileIndex(filePath, "utf8", PAGE_ROWS);
      const expected = parserRecordCount(text);
      assert.equal(index.totalRows, Math.max(0, expected - 1),
        `record count for ${JSON.stringify(text)}`);
      assert.equal(index.complete, true);
    });
  }
});

test("the index agrees with the parser on generated files, including chunk boundaries", async (t) => {
  // Deterministic pseudo-random rows covering quotes, embedded newlines and CRLF.
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let attempt = 0; attempt < 12; attempt++) {
    let text = "id,name,note\n";
    const rows = 40 + Math.floor(next() * 60);
    for (let row = 0; row < rows; row++) {
      const pick = next();
      if (pick < 0.25) text += `${row},"line\nbreak ${row}",plain\r\n`;
      else if (pick < 0.5) text += `${row},"say ""hi"" ${row}",plain\n`;
      else if (pick < 0.75) text += `${row},"a,b,c",plain\r\n`;
      else text += `${row},name${row},plain\n`;
    }
    if (attempt % 3 === 0) text = text.slice(0, -1); // no trailing terminator
    await withFile(t, Buffer.from(text, "utf8"), async (filePath) => {
      const index = await buildFileIndex(filePath, "utf8", PAGE_ROWS);
      assert.equal(index.totalRows, parserRecordCount(text) - 1, `attempt ${attempt}`);
    });
  }
});

test("page offsets land on the first record of each page", async (t) => {
  const lines = ["id,name"];
  for (let index = 1; index <= 450; index++) lines.push(`${index},name ${index}`);
  const text = lines.join("\n");

  await withFile(t, Buffer.from(text, "utf8"), async (filePath) => {
    const index = await buildFileIndex(filePath, "utf8", PAGE_ROWS);
    assert.equal(index.totalRows, 450);
    assert.equal(index.pageCount, 5, "450 rows fill four pages and start a fifth");

    const bytes = await fs.promises.readFile(filePath);
    for (let page = 1; page <= index.pageCount; page++) {
      const offset = index.pageOffset(page);
      const rest = bytes.subarray(offset).toString("utf8");
      const firstId = (page - 1) * PAGE_ROWS + 1;
      assert.ok(rest.startsWith(`${firstId},name ${firstId}`),
        `page ${page} must begin at record ${firstId}, found ${JSON.stringify(rest.slice(0, 20))}`);
    }
    assert.equal(index.pageForRow(2), 1, "the first data row is row 2");
    assert.equal(index.pageForRow(101), 1);
    assert.equal(index.pageForRow(102), 2);
    assert.equal(index.pageForRow(451), 5);
  });
});

test("offsets survive quoted newlines, which are not record boundaries", async (t) => {
  const lines = ["id,name"];
  for (let index = 1; index <= 250; index++) lines.push(`${index},"multi\nline ${index}"`);
  const text = lines.join("\n");

  await withFile(t, Buffer.from(text, "utf8"), async (filePath) => {
    const index = await buildFileIndex(filePath, "utf8", PAGE_ROWS);
    assert.equal(index.totalRows, 250, "a newline inside quotes does not end a record");
    const bytes = await fs.promises.readFile(filePath);
    assert.ok(bytes.subarray(index.pageOffset(2)).toString("utf8").startsWith('101,"multi'));
    assert.ok(bytes.subarray(index.pageOffset(3)).toString("utf8").startsWith('201,"multi'));
  });
});

test("multi-byte and UTF-16 encodings are indexed by their own units", async (t) => {
  const lines = ["姓名,城市"];
  for (let index = 1; index <= 250; index++) lines.push(`名前${index},"東京,都"`);
  const text = lines.join("\n");

  for (const encoding of ["shiftjis", "big5", "gbk", "utf16le", "utf16be"]) {
    const bytes = iconv.encode(text, encoding);
    await withFile(t, bytes, async (filePath) => {
      const index = await buildFileIndex(filePath, encoding, PAGE_ROWS);
      assert.equal(index.totalRows, 250, `${encoding} record count`);
      assert.equal(index.pageCount, 3, `${encoding} page count`);
      const decoded = iconv.decode(bytes.subarray(index.pageOffset(2)), encoding);
      assert.ok(decoded.startsWith("名前101,"), `${encoding} page 2 offset`);
    });
  }
});

test("indexing reports progress and can be called off part way", async (t) => {
  // Several chunks' worth, so progress genuinely reports more than once.
  const lines = ["id,name"];
  for (let index = 1; index <= 300000; index++) lines.push(`${index},name ${index} with some padding`);

  await withFile(t, Buffer.from(lines.join("\n"), "utf8"), async (filePath) => {
    const seen = [];
    const full = await buildFileIndex(filePath, "utf8", PAGE_ROWS, {
      progress: (bytes) => seen.push(bytes),
    });
    assert.equal(full.complete, true);
    assert.equal(full.totalRows, 300000);
    assert.ok(seen.length > 1, "progress is reported as the file is read");
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "progress only moves forward");

    let calls = 0;
    const stopped = await buildFileIndex(filePath, "utf8", PAGE_ROWS, {
      cancelled: () => ++calls > 1,
    });
    assert.equal(stopped.complete, false, "a cancelled pass never claims a total");
    assert.ok(stopped.totalRows === 0);
  });
});

test("an empty or header-only file has no data rows and no pages", async (t) => {
  await withFile(t, Buffer.from("", "utf8"), async (filePath) => {
    const index = await buildFileIndex(filePath, "utf8", PAGE_ROWS);
    assert.equal(index.totalRows, 0);
    assert.equal(index.pageCount, 0);
    assert.equal(index.pageForRow(2), null);
  });
  await withFile(t, Buffer.from("id,name\n", "utf8"), async (filePath) => {
    const index = await buildFileIndex(filePath, "utf8", PAGE_ROWS);
    assert.equal(index.totalRows, 0);
    assert.equal(index.pageCount, 0);
  });
});
