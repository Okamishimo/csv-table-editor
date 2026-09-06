"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const {
  alignColumns,
  buildDiff,
  changedSlots,
  diffHtml,
  parseCsv,
  showTableDiff,
} = require("../src/history-diff");

/** The classes each side paints on a row, as the panes render them. */
function paneRows(document, pane) {
  return Array.from(document.querySelectorAll(`#${pane} tbody tr`)).map((row) => ({
    className: row.className,
    number: row.cells[0].textContent,
    cells: Array.from(row.cells).slice(1).map((cell) => ({
      text: cell.textContent,
      className: cell.className,
    })),
  }));
}

function render(before, after, title = "history ↔ current") {
  const dom = new JSDOM(diffHtml(before, after, title));
  return { document: dom.window.document, dom };
}

const BEFORE = "id,name,city\n1,Alice,Taipei\n2,Bob,Osaka\n3,Chen,Seoul";

test("a changed row highlights only the cells that changed", (t) => {
  const after = "id,name,city\n1,Alice,Taipei\n2,Bobby,Kyoto\n3,Chen,Seoul";
  const { document, dom } = render(BEFORE, after);
  t.after(() => dom.window.close());

  const right = paneRows(document, "pane-right");
  const row = right[2];
  assert.equal(row.className, "row-changed");
  assert.deepEqual(row.cells.map((cell) => cell.className), ["", "cell-changed", "cell-changed"],
    "the id did not change, so it is not painted");
  assert.deepEqual(row.cells.map((cell) => cell.text), ["2", "Bobby", "Kyoto"]);

  // The other side marks the same cells, showing what they were.
  const left = paneRows(document, "pane-left");
  assert.deepEqual(left[2].cells.map((cell) => cell.className), ["", "cell-changed", "cell-changed"]);
  assert.deepEqual(left[2].cells.map((cell) => cell.text), ["2", "Bob", "Osaka"]);

  // Untouched rows carry nothing at all.
  assert.equal(right[1].className, "row-same");
  assert.deepEqual(right[1].cells.map((cell) => cell.className), ["", "", ""]);
});

test("a row that was added is painted whole, cells and all", (t) => {
  const { document, dom } = render(BEFORE, `${BEFORE}\n4,Dana,Kobe`);
  t.after(() => dom.window.close());

  const added = paneRows(document, "pane-right").find((row) => row.className === "row-added");
  assert.ok(added, "the appended row is an addition, not a change");
  assert.deepEqual(added.cells.map((cell) => cell.text), ["4", "Dana", "Kobe"]);
  assert.deepEqual(added.cells.map((cell) => cell.className), ["", "", ""],
    "the row carries the colour, so the cells need none");
  // The old version has nothing there at all.
  assert.equal(paneRows(document, "pane-left").at(-1).className, "gap");

  const style = document.querySelector("style").textContent;
  assert.match(style, /tr\.row-added td \{ background/);
  assert.match(style, /tr\.row-removed td \{ background/);
  assert.match(style, /td\.cell-changed \{ background/);
});

test("a row that was removed is painted whole on the side that had it", (t) => {
  const after = "id,name,city\n1,Alice,Taipei\n2,Bob,Osaka";
  const { document, dom } = render(BEFORE, after);
  t.after(() => dom.window.close());

  const removed = paneRows(document, "pane-left").find((row) => row.className === "row-removed");
  assert.ok(removed);
  assert.deepEqual(removed.cells.map((cell) => cell.text), ["3", "Chen", "Seoul"]);
  assert.deepEqual(removed.cells.map((cell) => cell.className), ["", "", ""]);
  assert.equal(paneRows(document, "pane-right").at(-1).className, "gap");
});

test("a row replaced outright reads as a change, with every cell marked", (t) => {
  const after = "id,name,city\n1,Alice,Taipei\n2,Bob,Osaka\n4,Dana,Kobe";
  const { document, dom } = render(BEFORE, after);
  t.after(() => dom.window.close());

  const changed = paneRows(document, "pane-right").find((row) => row.className === "row-changed");
  assert.ok(changed, "a removal followed by an addition is one row changing");
  assert.deepEqual(changed.cells.map((cell) => cell.className),
    ["cell-changed", "cell-changed", "cell-changed"],
    "every value differs, so every cell is marked on its own account");
});

test("only the differing cell is painted even when values repeat across the row", (t) => {
  const { document, dom } = render("a,b,c\nx,x,x", "a,b,c\nx,y,x");
  t.after(() => dom.window.close());
  const row = paneRows(document, "pane-right")[1];
  assert.deepEqual(row.cells.map((cell) => cell.className), ["", "cell-changed", ""]);
});

test("an added column is painted whole, and does not make every cell look changed", (t) => {
  const after = "id,name,note,city\n1,Alice,first,Taipei\n2,Bob,second,Osaka\n3,Chen,third,Seoul";
  const { document, dom } = render(BEFORE, after);
  t.after(() => dom.window.close());

  const { counts, slots } = buildDiff(BEFORE, after);
  assert.equal(counts.addedColumns, 1);
  assert.equal(counts.changed, 0, "shifting values along is a new column, not changed rows");
  assert.equal(counts.added, 0);
  assert.equal(counts.removed, 0);
  assert.equal(slots.length, 4);

  const right = paneRows(document, "pane-right");
  for (const row of right) {
    assert.equal(row.cells[2].className, "col-added", "the new column is coloured in every row");
    assert.deepEqual([row.cells[0].className, row.cells[1].className, row.cells[3].className],
      ["", "", ""], "the columns that merely moved are not");
  }
  // The old version has no such column, so it shows a gap in its place.
  const left = paneRows(document, "pane-left");
  assert.equal(left[1].cells[2].className, "col-gap");
  assert.equal(left[1].cells[2].text, "");
  assert.deepEqual(left[1].cells.map((cell) => cell.text), ["1", "Alice", "", "Taipei"]);

  const header = document.querySelector("#pane-right thead tr");
  assert.equal(header.cells[3].className, "colname col-added");
  assert.equal(header.cells[3].textContent, "note");
});

test("a removed column is painted whole on the side that still has it", (t) => {
  const after = "id,city\n1,Taipei\n2,Osaka\n3,Seoul";
  const { document, dom } = render(BEFORE, after);
  t.after(() => dom.window.close());

  const { counts } = buildDiff(BEFORE, after);
  assert.equal(counts.removedColumns, 1);
  assert.equal(counts.changed, 0);

  const left = paneRows(document, "pane-left");
  assert.equal(left[1].cells[1].className, "col-removed");
  assert.equal(left[1].cells[1].text, "Alice");
  const right = paneRows(document, "pane-right");
  assert.equal(right[1].cells[1].className, "col-gap");
  assert.match(document.getElementById("bar").textContent, /Columns \+0 −1/);
});

test("a column change and a cell change are told apart in the same file", (t) => {
  const after = "id,name,note,city\n1,Alice,first,Taipei\n2,Bobby,second,Osaka\n3,Chen,third,Seoul";
  const { document, dom } = render(BEFORE, after);
  t.after(() => dom.window.close());

  const right = paneRows(document, "pane-right");
  const changed = right.find((row) => row.className === "row-changed");
  assert.ok(changed, "the row whose name changed is still a changed row");
  assert.deepEqual(changed.cells.map((cell) => cell.className),
    ["", "cell-changed", "col-added", ""],
    "the renamed cell and the new column are both marked, for their own reasons");
});

test("columns are matched by name, so a reordered column is not a rewrite", () => {
  const slots = alignColumns(["id", "name", "city"], ["id", "city", "name"]);
  const pairs = slots.map((slot) => `${slot.left}:${slot.right}`);
  // One of the two moved columns is reported as removed-and-added; the other
  // keeps its identity, which is the most an order-preserving alignment can do.
  assert.equal(slots.filter((slot) => slot.left !== null && slot.right !== null).length, 2);
  assert.ok(pairs.includes("0:0"), "the unmoved column keeps its pairing");
});

test("repeated header names still line up one for one", () => {
  const slots = alignColumns(["a", "a", "b"], ["a", "a", "b"]);
  assert.deepEqual(slots.map((slot) => [slot.left, slot.right]), [[0, 0], [1, 1], [2, 2]]);
});

test("identical files show nothing at all", (t) => {
  const { document, dom } = render(BEFORE, BEFORE);
  t.after(() => dom.window.close());
  const classes = paneRows(document, "pane-right").map((row) => row.className);
  assert.deepEqual(new Set(classes), new Set(["row-same"]));
  assert.equal(document.querySelectorAll(".cell-changed, .col-added, .col-removed").length, 0);
  assert.match(document.getElementById("bar").textContent, /Added 0.*Removed 0.*Changed 0/s);
});

test("quoted values, embedded newlines and CRLF survive the parse", () => {
  const rows = parseCsv('a,b\r\n"x,y","line\nbreak"\r\n"say ""hi""",2\r\n');
  assert.deepEqual(rows, [
    ["a", "b"],
    ["x,y", "line\nbreak"],
    ['say "hi"', "2"],
    ["", ""],
  ]);
});

test("cell values are escaped rather than rendered", (t) => {
  const after = 'id,name,city\n1,<img src=x>,Taipei\n2,Bob,Osaka\n3,Chen,Seoul';
  const { document, dom } = render(BEFORE, after);
  t.after(() => dom.window.close());
  assert.equal(document.querySelectorAll("#pane-right img").length, 0);
  const changed = paneRows(document, "pane-right").find((row) => row.className === "row-changed");
  assert.equal(changed.cells[1].text, "<img src=x>");
});

test("aligning very large files falls back to comparing by position", () => {
  // Far more differing rows than the alignment budget allows.
  const before = ["id"];
  const after = ["id"];
  for (let index = 0; index < 3000; index++) {
    before.push(`left ${index}`);
    after.push(`right ${index}`);
  }
  const { entries } = buildDiff(before.join("\n"), after.join("\n"));
  assert.equal(entries.length, 3001, "every row is still accounted for");
  assert.equal(entries.filter((entry) => entry.status === "changed").length, 3000,
    "paired by position rather than left unaligned");
});

test("the diff opens in a retained, script-enabled panel", () => {
  const created = [];
  const vscode = {
    ViewColumn: { Active: 1 },
    window: {
      createWebviewPanel(viewType, title, column, options) {
        const panel = { viewType, title, column, options, webview: { html: "" } };
        created.push(panel);
        return panel;
      },
    },
  };
  const panel = showTableDiff(BEFORE, BEFORE, "a ↔ b", vscode);
  assert.equal(created.length, 1);
  assert.equal(panel.viewType, "csvTableEditor.diff");
  assert.deepEqual(panel.options, { enableScripts: true, retainContextWhenHidden: true });
  assert.match(panel.webview.html, /^<!DOCTYPE html>/);
  assert.match(panel.webview.html, /Content-Security-Policy/);
});

test("the nonce covers both the stylesheet and the script", () => {
  const html = diffHtml(BEFORE, BEFORE, "t");
  const policy = html.match(/style-src 'nonce-([A-Za-z0-9]{32})'/);
  assert.ok(policy, "the policy names a nonce");
  assert.ok(html.includes(`<style nonce="${policy[1]}">`));
  assert.ok(html.includes(`<script nonce="${policy[1]}">`));
  assert.doesNotMatch(html, /\son[a-z]+=/, "no inline event handlers");
});

test("several adjacent edits align as changed rows with only their changed cells highlighted", () => {
  const diff = buildDiff("id,name\n1,A\n2,B\n3,C", "id,name\n1,AA\n2,BB\n3,CC");
  assert.equal(diff.counts.changed, 3);
  assert.equal(diff.counts.added, 0);
  assert.equal(diff.counts.removed, 0);
  for (const entry of diff.entries.slice(1)) assert.deepEqual([...changedSlots(entry, diff.slots)], [1]);
});

function navigableDiff(t, before, after) {
  const scrolled = [];
  const dom = new JSDOM(diffHtml(before, after, "Changes"), {
    runScripts: "dangerously",
    beforeParse(window) {
      window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); };
    },
  });
  t.after(() => dom.window.close());
  return { document: dom.window.document, window: dom.window, scrolled };
}

test("history opens at its first change and buttons and keyboard move both panes", (t) => {
  const { document, window, scrolled } = navigableDiff(t,
    "id,name\n1,A\n2,B\n3,C\n4,D", "id,name\n1,A\n2,BB\n3,C\n4,DD");
  const count = document.getElementById("change-position");
  assert.equal(count.textContent, "1/2 changes");
  assert.equal(scrolled.length, 2);
  assert.equal(scrolled[1].textContent, "BB");
  assert.equal(document.querySelectorAll("tr.diff-current").length, 2);
  document.getElementById("change-next").click();
  assert.equal(count.textContent, "2/2 changes");
  assert.equal(scrolled.at(-1).textContent, "DD");
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "F7", shiftKey: true, bubbles: true }));
  assert.equal(count.textContent, "1/2 changes");
  document.getElementById("change-prev").click();
  assert.equal(count.textContent, "2/2 changes");
});

test("history navigation covers added and removed rows and columns and disables itself for identical files", (t) => {
  for (const [before, after] of [["id\n1", "id\n1\n2"], ["id\n1\n2", "id\n1"], ["id\n1", "id,note\n1,new"]]) {
    const { document, scrolled } = navigableDiff(t, before, after);
    assert.equal(scrolled.length, 2);
    assert.equal(document.getElementById("change-next").disabled, false);
  }
  const { document, scrolled } = navigableDiff(t, "id\n1", "id\n1");
  assert.equal(scrolled.length, 0);
  assert.equal(document.getElementById("change-position").textContent, "No changes");
  assert.equal(document.getElementById("change-next").disabled, true);
  assert.equal(document.getElementById("change-prev").disabled, true);
});
