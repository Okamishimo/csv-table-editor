"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const editHistory = require("../src/edit-history");

/** Build the grid webview through the whole shipped decorator chain. */
function decoratedGridHtml() {
  const bundlePath = path.join(__dirname, "..", "dist", "extension.js");
  const source = fs.readFileSync(bundlePath, "utf8").replace(
    "module.exports=i})();",
    "i.__testRequire=n,module.exports=i})();"
  );
  const bundleModule = new Module(path.join(path.dirname(bundlePath), "extension.history.js"), module);
  bundleModule.filename = path.join(path.dirname(bundlePath), "extension.history.js");
  bundleModule.paths = Module._nodeModulePaths(path.dirname(bundlePath));
  const originalLoad = Module._load;
  Module._load = function loadWithVscodeStub(request, parent, isMain) {
    if (request === "vscode") return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    bundleModule._compile(source, bundleModule.filename);
  } finally {
    Module._load = originalLoad;
  }
  const raw = bundleModule.exports.__testRequire(598).getWebviewHtml({}, {});
  let html = raw;
  for (const name of ["font-settings", "search-scope", "grid-performance", "grid-virtualization", "edit-history"]) {
    html = require(`../src/${name}`).decorateWebviewHtml(html);
  }
  return html;
}

/**
 * Open the grid and model the host side of the undo stack: every committed edit
 * is kept, and undo/redo send the recorded operation back exactly as
 * `registerEdit` does in the bundle.
 */
function openGrid(text) {
  const posted = [];
  const dom = new JSDOM(decoratedGridHtml(), {
    runScripts: "dangerously",
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({ postMessage: (message) => posted.push(message) });
      window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
      // JSDOM implements no innerText; the grid reads it when committing a cell.
      Object.defineProperty(window.HTMLElement.prototype, "innerText", {
        configurable: true,
        get() { return this.textContent; },
        set(value) { this.textContent = value; },
      });
    },
  });
  const { window } = dom;
  const send = (message) => window.dispatchEvent(new window.MessageEvent("message", { data: message }));
  send({ type: "init", text, encodingLabel: "UTF-8", fileName: "grid.csv" });

  const plain = (value) => JSON.parse(JSON.stringify(value));
  const editMessages = () => posted.filter((message) => message.type === "edit");
  const stack = [];
  let cursor = 0;

  return {
    window,
    document: window.document,
    posted,
    send,
    stack,
    edits: () => editMessages().map(plain),
    /** Move newly committed edits onto the modelled undo stack. */
    record() {
      const committed = editMessages();
      while (stack.length < committed.length) stack.push(committed[stack.length]);
      cursor = stack.length;
    },
    undo() { send({ type: "applyEdit", op: stack[--cursor].undo }); },
    redo() { send({ type: "applyEdit", op: stack[cursor++].redo }); },
    /** The grid exactly as a save would serialize it. */
    grid() {
      send({ type: "requestGridData", requestId: posted.length + 1 });
      const reply = posted.at(-1);
      assert.equal(reply.type, "gridData");
      return plain(reply.grid);
    },
    click(selector) {
      const element = window.document.querySelector(selector);
      assert.ok(element, `no element for ${selector}`);
      element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    },
  };
}

/** Commit a cell edit the way focusing and then leaving a cell does. */
function editCell(harness, r, c, value) {
  const td = harness.document.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
  assert.ok(td, `cell ${r},${c} is not rendered`);
  const cell = td.querySelector(".cell");
  cell.textContent = value;
  cell.dispatchEvent(new harness.window.FocusEvent("focusout", { bubbles: true }));
  harness.record();
}

const SAMPLE = "id,name,city\n1,Alice,Taipei\n2,Bob,Osaka\n3,Chen,Seoul";

test("expanded multiline editing preserves line breaks through save, undo and redo", (t) => {
  const original = 'first\r\nsecond\r\n';
  const harness = openGrid('id,note\n1,"' + original + '"');
  t.after(() => harness.window.close());
  const cell = harness.document.querySelector('td[data-r="1"][data-c="1"] .cell');
  cell.focus();
  cell.dispatchEvent(new harness.window.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(harness.grid()[1][1], original);
  assert.equal(harness.edits().length, 0);
  const edited = 'edited\nsecond\nthird\n';
  editCell(harness, 1, 1, edited);
  assert.equal(harness.grid()[1][1], edited);
  harness.undo();
  assert.equal(harness.grid()[1][1], original);
  harness.redo();
  assert.equal(harness.grid()[1][1], edited);
});

test("decorator is idempotent and refuses a bundle it does not recognise", () => {
  const once = decoratedGridHtml();
  assert.equal(editHistory.decorateWebviewHtml(once), once);
  assert.throws(
    () => editHistory.decorateWebviewHtml("<html><body>nothing to patch</body></html>"),
    /Cannot apply edit history patch/
  );
});

test("a cell edit travels as the change, not as two copies of the grid", () => {
  const harness = openGrid(SAMPLE);
  editCell(harness, 2, 1, "Bobby");

  const [edit] = harness.edits();
  assert.equal(edit.label, "Edit cell B3");
  assert.deepEqual(edit.undo, { k: "cell", r: 2, c: 1, v: "Bob" });
  assert.deepEqual(edit.redo, { k: "cell", r: 2, c: 1, v: "Bobby" });
  assert.equal("snapshot" in edit, false, "no whole-grid payload");
  assert.equal("prevSnapshot" in edit, false, "no whole-grid payload");
});

test("undo and redo round-trip a cell edit", () => {
  const harness = openGrid(SAMPLE);
  editCell(harness, 2, 1, "Bobby");
  assert.equal(harness.grid()[2][1], "Bobby");

  harness.undo();
  assert.equal(harness.grid()[2][1], "Bob");
  harness.redo();
  assert.equal(harness.grid()[2][1], "Bobby");
});

test("deleting a row carries only that row and restores it exactly", () => {
  const harness = openGrid(SAMPLE);
  const before = harness.grid();
  harness.click('[data-delrow="2"]');
  harness.record();

  const [edit] = harness.edits();
  assert.equal(edit.label, "Delete row 3");
  assert.deepEqual(edit.undo.row, ["2", "Bob", "Osaka"]);
  assert.equal(edit.undo.k, "rowIn");
  assert.equal(edit.redo.k, "rowOut");
  assert.equal(harness.grid().length, before.length - 1);

  harness.undo();
  assert.deepEqual(harness.grid(), before, "undo restores the row where it was");
  harness.redo();
  assert.equal(harness.grid().length, before.length - 1);
});

test("deleting a column carries one value per row and restores them in place", () => {
  const harness = openGrid(SAMPLE);
  const before = harness.grid();
  harness.click('[data-delcol="1"]');
  harness.record();

  const [edit] = harness.edits();
  assert.equal(edit.label, "Delete column B");
  assert.deepEqual(edit.undo, { k: "colIn", at: 1, values: ["name", "Alice", "Bob", "Chen"], sortCol: -1, sortDir: null });
  assert.deepEqual(harness.grid(), before.map((row) => [row[0], row[2]]));

  harness.undo();
  assert.deepEqual(harness.grid(), before);
  harness.redo();
  assert.deepEqual(harness.grid(), before.map((row) => [row[0], row[2]]));
});

test("adding a row or column round-trips without carrying the grid", () => {
  const harness = openGrid(SAMPLE);
  const before = harness.grid();

  harness.click("#add-row");
  harness.record();
  assert.equal(harness.grid().length, before.length + 1);
  assert.deepEqual(harness.edits()[0].undo, { k: "rowOut", at: before.length, headerRow: 0 });

  harness.click("#add-col");
  harness.record();
  assert.equal(harness.grid()[0].length, before[0].length + 1);
  // A blank column needs no payload at all.
  assert.deepEqual(harness.edits()[1].redo, { k: "colIn", at: before[0].length, sortCol: -1, sortDir: null });

  harness.undo();
  assert.equal(harness.grid()[0].length, before[0].length);
  harness.undo();
  assert.deepEqual(harness.grid(), before);
});

test("several edits undo in reverse order and leave the original grid", () => {
  const harness = openGrid(SAMPLE);
  const before = harness.grid();

  editCell(harness, 1, 1, "Alicia");
  harness.click('[data-delrow="3"]');
  harness.record();
  editCell(harness, 2, 2, "Kyoto");
  harness.click("#add-row");
  harness.record();

  assert.equal(harness.edits().length, 4);
  for (let i = 0; i < 4; i++) harness.undo();
  assert.deepEqual(harness.grid(), before, "the grid returns to exactly its initial state");

  for (let i = 0; i < 4; i++) harness.redo();
  assert.equal(harness.grid()[1][1], "Alicia");
  assert.equal(harness.grid()[2][2], "Kyoto");
});

test("undoing a cell edit leaves a sort applied afterwards alone", () => {
  const harness = openGrid(SAMPLE);
  editCell(harness, 1, 1, "Zoe");

  // Select the column, then sort it: the grid keeps file order, the view does not.
  harness.click('thead th[data-colhead="1"]');
  harness.click('[data-sortcol="1"]');
  assert.ok(harness.document.querySelector(".sort-header.sorted"));

  harness.undo();
  assert.equal(harness.grid()[1][1], "Alice", "the value is restored");
  assert.ok(harness.document.querySelector(".sort-header.sorted"),
    "a sort the reader applied after the edit must survive undoing that edit");
});

test("undoing a column deletion restores the sort that deletion cleared", () => {
  const harness = openGrid(SAMPLE);
  harness.click('thead th[data-colhead="1"]');
  harness.click('[data-sortcol="1"]');
  assert.ok(harness.document.querySelector(".sort-header.sorted"));

  harness.click('[data-delcol="1"]');
  harness.record();
  assert.equal(harness.document.querySelector(".sort-header.sorted"), null,
    "deleting the sorted column clears the sort");

  harness.undo();
  assert.ok(harness.document.querySelector(".sort-header.sorted"),
    "undo brings the sort back with the column");
});

test("deleting the header row moves the header and undo puts it back", () => {
  const harness = openGrid("preamble\nid,name\n1,Alice\n2,Bob");
  const before = harness.grid();
  const headerBefore = harness.document.getElementById("header-info").textContent;

  harness.click('[data-delrow="1"]');
  harness.record();
  harness.undo();

  assert.deepEqual(harness.grid(), before);
  assert.equal(harness.document.getElementById("header-info").textContent, headerBefore,
    "the header position is part of what the operation restores");
});

test("a history rollback still travels whole, because the whole grid is the change", () => {
  const harness = openGrid(SAMPLE);
  const before = harness.grid();
  harness.send({ type: "rollback", text: "id,name\n9,Rolled", encodingLabel: "UTF-8" });
  harness.record();

  const [edit] = harness.edits();
  assert.equal(edit.label, "Roll back to history version");
  assert.equal(edit.undo.k, "full");
  assert.deepEqual(edit.undo.grid, before);
  assert.deepEqual(harness.grid(), [["id", "name"], ["9", "Rolled"]]);

  harness.undo();
  assert.deepEqual(harness.grid(), before);
});

test("an edit message stays small however large the grid is", () => {
  const rows = ["id,name,note"];
  for (let r = 1; r < 4000; r++) rows.push(`${r},name${r},a fairly long note value ${r}`);
  const harness = openGrid(rows.join("\n"));
  const gridBytes = JSON.stringify(harness.grid()).length;

  editCell(harness, 1, 1, "changed");
  const editBytes = JSON.stringify(harness.edits()[0]).length;

  assert.ok(gridBytes > 150000, `expected a large grid, got ${gridBytes} bytes`);
  assert.ok(editBytes < 200,
    `an edit must describe the change, not the grid: ${editBytes} bytes against ${gridBytes}`);
});

test("saving rapid edits flushes the focused cell once and preserves undo deltas", (t) => {
  const h = openGrid("id,name\n1,Alice\n2,Bob");
  t.after(() => h.window.close());
  editCell(h, 1, 1, "Alicia");
  const cell = h.document.querySelector('td[data-r="2"][data-c="1"] .cell');
  cell.focus();
  cell.textContent = "Bobby";
  assert.deepEqual(h.grid(), [["id", "name"], ["1", "Alicia"], ["2", "Bobby"]]);
  assert.equal(h.edits().length, 2);
  h.grid();
  assert.equal(h.edits().length, 2, "repeated saves do not duplicate undo entries");
  cell.blur();
  assert.equal(h.edits().length, 2, "leaving the saved cell does not commit it twice");
  h.record();
  h.undo();
  assert.equal(h.grid()[2][1], "Bob");
});
