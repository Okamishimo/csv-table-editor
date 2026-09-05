"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const iconv = require("iconv-lite");

const { LargeCsvDocument, resolveLargeFileEditor } = require("../src/large-file-mode");

/**
 * The messages the provider actually posts to the preview. The Webview tests
 * simulate these, so only a test that drives the real resolver can prove the
 * two sides agree on their shape.
 */

const encodingApi = {
  SUPPORTED_ENCODINGS: [{ id: "utf8", label: "UTF-8" }],
  encodingKey: (encoding) => encoding.id,
  findEncoding: (key) => ({ id: key, label: key.toUpperCase() }),
  detectEncoding: () => "utf8",
  decode: (bytes, key) => iconv.decode(Buffer.from(bytes), key),
  createDecoder: (key) => iconv.getDecoder(key),
};

class EventEmitterStub {
  constructor() { this.event = () => ({ dispose() {} }); }
  fire() {}
  dispose() {}
}

function vscodeStub() {
  return {
    EventEmitter: EventEmitterStub,
    window: { showQuickPick: async () => undefined, showInformationMessage: async () => undefined },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => fallback }) },
    commands: { executeCommand: async () => {} },
  };
}

async function openPreview(t, lines) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "csv-table-editor-resolver-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "large.csv");
  const text = lines.join("\n");
  await fs.promises.writeFile(filePath, text);

  const vscode = vscodeStub();
  const uri = { fsPath: filePath, path: filePath, scheme: "file", toString: () => `file://${filePath}` };
  const document = await LargeCsvDocument.create(uri, Buffer.byteLength(text), vscode, encodingApi);
  t.after(() => document.dispose());

  const posted = [];
  /** Waiters for messages that have not been posted yet. */
  const pending = [];
  let receive;
  const panel = {
    webview: {
      options: {},
      html: "",
      postMessage: (message) => {
        posted.push(message);
        for (const waiter of pending.splice(0)) {
          if (waiter.match(message)) waiter.resolve(message);
          else pending.push(waiter);
        }
        return true;
      },
      onDidReceiveMessage: (listener) => { receive = listener; return { dispose() {} }; },
    },
    onDidDispose: () => ({ dispose() {} }),
  };
  await resolveLargeFileEditor(document, panel, vscode, encodingApi);

  const send = (message) => receive(message);
  const of = (type) => posted.filter((message) => message.type === type);

  /**
   * Wait for a message the provider posts. Driven by the posts themselves
   * rather than by a number of event-loop turns, because indexing is real file
   * I/O whose cost is the machine's to decide.
   */
  const waitFor = (match, description) => {
    const already = posted.find(match);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = pending.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) pending.splice(index, 1);
        reject(new Error(`timed out waiting for ${description}`));
      }, 30000);
      pending.push({
        match,
        timer,
        resolve: (message) => { clearTimeout(timer); resolve(message); },
      });
    });
  };

  const indexed = () => waitFor(
    (message) => message.type === "fileIndex" && message.complete,
    "the file to be indexed"
  );
  return { document, posted, send, of, indexed, waitFor, panel };
}

function rows(count) {
  const lines = ["id,name"];
  for (let index = 1; index <= count; index++) lines.push(`${index},name ${index}`);
  return lines;
}

test("opening the preview sends the first page and then the file's row count", async (t) => {
  const { send, of, indexed } = await openPreview(t, rows(2500));
  await send({ type: "ready" });

  const init = of("init")[0];
  assert.ok(init, "the preview is told what it is showing");
  assert.equal(init.delimiterLabel, "Comma");

  const first = of("page")[0];
  assert.equal(first.mode, "replace");
  assert.equal(first.startRow, 2);
  assert.deepEqual(first.header, ["id", "name"]);

  const total = await indexed();
  assert.equal(total.totalRows, 2500, "the scrollbar is told how many rows there are");
  assert.equal(total.size > 0, true);
});

test("a scrollbar jump keeps the reader where they dragged to", async (t) => {
  const { send, of, indexed } = await openPreview(t, rows(2500));
  await send({ type: "ready" });
  await indexed();

  await send({ type: "gotoRow", row: 1500 });
  const jump = of("page").at(-1);

  assert.equal(jump.mode, "replace", "the window is replaced with the rows around that point");
  assert.equal(jump.keepScroll, true,
    "a jump the reader made must not send them back to the first row");
  assert.equal(jump.startRow, 1402, "row 1500 lives on the page starting at 1402");
  assert.ok(jump.rows.some((row) => row[0] === "1499"), "and that page holds the row asked for");
});

test("a jump to a match carries the cell to reveal, and does not keep the scroll", async (t) => {
  const { send, of, indexed } = await openPreview(t, rows(2500));
  await send({ type: "ready" });
  await indexed();

  await send({ type: "gotoMatch", page: 12, row: 1150, column: 1 });
  const jump = of("page").at(-1);

  assert.equal(jump.mode, "replace");
  assert.deepEqual(jump.focus, { row: 1150, column: 1 });
  assert.equal(jump.keepScroll, false, "the reveal decides the position, not the old scroll");
  assert.equal(jump.startRow, 1102);
});

test("ordinary paging is neither a jump nor a reveal", async (t) => {
  const { send, of, indexed } = await openPreview(t, rows(2500));
  await send({ type: "ready" });
  await indexed();

  await send({ type: "nextPage", afterPage: 1 });
  const next = of("page").at(-1);
  assert.equal(next.mode, "append");
  assert.equal(next.keepScroll, false);
  assert.equal(next.focus, null);
  assert.equal(next.startRow, 102);

  await send({ type: "previousPage", beforePage: 2 });
  const previous = of("page").at(-1);
  assert.equal(previous.mode, "prepend");
  assert.equal(previous.startRow, 2);
});

test("a whole-file search reports matches and shows the pages it sweeps", async (t) => {
  const lines = ["id,name"];
  for (let index = 1; index <= 3000; index++) {
    lines.push(`${index},${index === 2500 ? "needle" : "plain"} ${index}`);
  }
  const { send, of, indexed } = await openPreview(t, lines);
  await send({ type: "ready" });
  await indexed();

  await send({ type: "searchFile", query: "needle", column: -1, fromRow: 2 });

  const reports = of("searchMatches");
  assert.ok(reports.length > 0, "the scan reports as it reads");
  const final = reports.at(-1);
  assert.equal(final.done, true);
  assert.equal(final.total, 1);
  assert.equal(final.truncated, false);
  const found = reports.flatMap((report) => report.matches);
  assert.deepEqual(found, [{ r: 2501, c: 1, p: 25 }], "the needle is row 2501, on page 25");

  const followed = of("page").filter((message) => message.follow);
  assert.ok(followed.length > 0, "the reader can see how far the scan has reached");
  for (const page of followed) {
    assert.equal(page.mode, "replace");
    assert.equal(page.keepScroll, false, "a followed page moves the view to the scan");
  }
});

test("a row past the end of the file asks for nothing and unblocks the preview", async (t) => {
  const { send, of, indexed } = await openPreview(t, rows(300));
  await send({ type: "ready" });
  await indexed();
  const before = of("page").length;

  await send({ type: "gotoRow", row: 99999 });
  assert.equal(of("page").length, before, "there is no such page to send");
  assert.equal(of("loading").at(-1).loading, false,
    "the preview is released so the next scroll can ask again");
});
