"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const iconv = require("iconv-lite");
const detector = require("../src/encoding-detector");
const {
  CsvStreamPager,
  StreamingCsvParser,
  createLargeDocumentIfNeeded,
  detectDelimiter,
  requestEditableReopen,
} = require("../src/large-file-mode");

const encodingApi = {
  detectEncoding: (bytes) => detector.detectEncoding(bytes, iconv),
  decode: (bytes, key) => iconv.decode(Buffer.from(bytes), findEncoding(key).id),
  createDecoder: (key) => iconv.getDecoder(findEncoding(key).id),
};

function findEncoding(key) {
  const bom = key.endsWith("-bom");
  return { id: bom ? key.slice(0, -4) : key, bom };
}

class EventEmitterStub {
  constructor() {
    this.event = () => {};
  }
  dispose() {}
}

test("streaming parser handles quoted delimiters, escaped quotes and multiline cells across chunks", () => {
  const parser = new StreamingCsvParser(",");
  parser.push('name,note\r\n"Alice","hello, "');
  parser.push('"world""\nnext line"\r');
  parser.push("\nBob,test");
  parser.finish();

  assert.deepEqual(parser.takeRows(10), [
    ["name", "note"],
    ["Alice", 'hello, "world"\nnext line'],
    ["Bob", "test"],
  ]);
});

test("streaming parser bounds pathological cells, rows and column counts", () => {
  const parser = new StreamingCsvParser(",");
  const columns = ["id", "x".repeat(100_000)];
  for (let index = 2; index < 150; index++) columns.push(`value-${index}`);
  parser.push(columns.join(",") + "\n");
  parser.finish();

  const [row] = parser.takeRows(1);
  assert.equal(row.length, 100);
  assert.ok(row[1].length < 4_200);
  assert.match(row[1], /preview truncated/);
  assert.equal(parser.truncatedCells, 1);
  assert.equal(parser.truncatedColumns, true);
});

test("stream pager keeps only a bounded page and retains the header", async () => {
  const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "csv-table-editor-"));
  const filePath = path.join(temporaryDirectory, "large.csv");
  const lines = ["id,name"];
  for (let index = 1; index <= 1_205; index++) lines.push(`${index},Name ${index}`);
  await fs.promises.writeFile(filePath, lines.join("\n"));

  try {
    const pager = new CsvStreamPager(filePath, "utf8", ",", encodingApi);
    const first = await pager.nextPage();
    const second = await pager.nextPage();
    assert.deepEqual(first.header, ["id", "name"]);
    assert.equal(first.rows.length, 100);
    assert.equal(first.startRow, 2);
    assert.equal(first.endRow, 101);
    assert.equal(second.rows.length, 100);
    assert.equal(second.startRow, 102);
    const previous = await pager.previousPage(2);
    assert.deepEqual(previous.rows, first.rows);
    const cachedSecond = await pager.nextPage(1);
    assert.deepEqual(cachedSecond.rows, second.rows);
    let last = cachedSecond;
    while (!last.done) last = await pager.nextPage();
    assert.equal(last.rows.length, 5);
    assert.equal(last.startRow, 1_202);
    assert.equal(last.done, true);
    assert.equal(last.endRow, 1_206);
    const cachePath = pager.cachePath;
    await pager.close();
    assert.equal(fs.existsSync(cachePath), false);
  } finally {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("large local files use streaming mode and detect encoding from a sample", async () => {
  const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "csv-table-editor-"));
  const filePath = path.join(temporaryDirectory, "traditional.csv");
  await fs.promises.writeFile(filePath, iconv.encode("姓名,城市\r\n王小明,臺北\r\n", "big5"));
  const openContext = {};
  const uri = {
    scheme: "file",
    fsPath: filePath,
    path: "/traditional.csv",
    toString: () => `file://${filePath}`,
  };
  const vscode = {
    EventEmitter: EventEmitterStub,
    workspace: {
      fs: { stat: async () => ({ size: 1_839.9 * 1024 * 1024 }) },
      getConfiguration: () => ({ get: () => 64 }),
    },
  };

  try {
    const document = await createLargeDocumentIfNeeded(uri, openContext, vscode, encodingApi);
    assert.equal(document.isLargeFile, true);
    assert.equal(document.encodingKey, "big5");
    assert.equal(document.canEnableEditing, false);
    const page = await document.nextPage();
    assert.deepEqual(page.header, ["姓名", "城市"]);
    assert.deepEqual(page.rows, [["王小明", "臺北"]]);
    document.dispose();
  } finally {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("files below the threshold stay in editable mode without a second stat", async () => {
  const openContext = {};
  const uri = { scheme: "file", toString: () => "file:///small.csv" };
  const vscode = {
    workspace: {
      fs: { stat: async () => ({ size: 10 * 1024 * 1024 }) },
      getConfiguration: () => ({ get: () => 64 }),
    },
  };
  assert.equal(await createLargeDocumentIfNeeded(uri, openContext, vscode, encodingApi), null);
  assert.equal(openContext.__csvTableEditorAllowLargeFile, true);
});

test("detects delimiters for CSV and TSV previews", () => {
  assert.equal(detectDelimiter("a,b,c\n1,2,3\n", "file.csv"), ",");
  assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3\n", "file.tsv"), "\t");
  assert.equal(detectDelimiter("a;b;c\n1;2;3\n", "file.csv"), ";");
});

test("explicit Enable Editing reopens a supported-size file in full-grid mode once", async () => {
  const uri = { scheme: "file", toString: () => "file:///editable-large.csv" };
  const document = {
    canEnableEditing: true,
    size: 100 * 1024 * 1024,
    uri,
  };
  const commands = [];
  const vscode = {
    window: { showWarningMessage: async () => "Enable Editing" },
    commands: { executeCommand: async (...args) => commands.push(args) },
    workspace: {
      fs: { stat: async () => ({ size: document.size }) },
      getConfiguration: () => ({ get: () => 64 }),
    },
  };

  await requestEditableReopen(document, vscode);
  assert.deepEqual(commands, [
    ["workbench.action.closeActiveEditor"],
    ["vscode.openWith", uri, "csvTableEditor.editor"],
  ]);

  const openContext = {};
  assert.equal(await createLargeDocumentIfNeeded(uri, openContext, vscode, encodingApi), null);
  assert.equal(openContext.__csvTableEditorAllowLargeFile, true);
});
