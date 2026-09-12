"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const gridVirtualization = require("../src/grid-virtualization");
const { OVERSCAN_ROWS } = gridVirtualization;
const { SEARCH_DEBOUNCE_MS } = require("../src/grid-performance");

const VIEWPORT_HEIGHT = 400;
const ROW_HEIGHT = 26;

function settleSearch() {
  return new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 60));
}

/** Build the fully decorated grid webview exactly as the provider does. */
function decoratedGridHtml() {
  const bundlePath = path.join(__dirname, "..", "dist", "extension.js");
  const source = fs.readFileSync(bundlePath, "utf8");
  const instrumented = source.replace(
    "module.exports=i})();",
    "i.__testRequire=n,module.exports=i})();"
  );
  const bundleModule = new Module(path.join(path.dirname(bundlePath), "extension.virtual.js"), module);
  bundleModule.filename = path.join(path.dirname(bundlePath), "extension.virtual.js");
  bundleModule.paths = Module._nodeModulePaths(path.dirname(bundlePath));

  const originalLoad = Module._load;
  Module._load = function loadWithVscodeStub(request, parent, isMain) {
    if (request === "vscode") return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    bundleModule._compile(instrumented, bundleModule.filename);
  } finally {
    Module._load = originalLoad;
  }

  const raw = bundleModule.exports.__testRequire(598).getWebviewHtml({}, {});
  return require("../src/edit-history").decorateWebviewHtml(
    gridVirtualization.decorateWebviewHtml(
      require("../src/grid-performance").decorateWebviewHtml(
        require("../src/search-scope").decorateWebviewHtml(
          require("../src/font-settings").decorateWebviewHtml(raw)
        )
      )
    )
  );
}

/**
 * Open the decorated grid with a measurable viewport. JSDOM has no layout, so
 * the scroller and row heights are modelled before the grid first renders.
 * Without `requestAnimationFrame` the grid updates its window synchronously,
 * which keeps these tests free of timing.
 */
function openGrid(text, { viewport = VIEWPORT_HEIGHT, rowHeight = ROW_HEIGHT, headerWidths = null } = {}) {
  const postedMessages = [];
  const scrolledCells = [];
  const dom = new JSDOM(decoratedGridHtml(), {
    runScripts: "dangerously",
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({ postMessage: (message) => postedMessages.push(message) });
      window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
        scrolledCells.push(this);
      };
    },
  });
  const { window } = dom;
  const wrap = window.document.getElementById("grid-wrap");
  let scrollTop = 0;
  Object.defineProperties(wrap, {
    clientHeight: { get: () => viewport, configurable: true },
    scrollTop: {
      get: () => scrollTop,
      set(value) { scrollTop = Math.max(0, value); },
      configurable: true,
    },
  });
  window.HTMLTableRowElement.prototype.getBoundingClientRect = function rect() {
    const height = this.className === "csv-spacer" ? 0 : rowHeight;
    return { top: 0, bottom: height, height };
  };
  // Automatic table layout would size columns from the rows currently in the
  // window; model a natural width per column so the pinning can be observed.
  window.HTMLTableCellElement.prototype.getBoundingClientRect = function rect() {
    const width = headerWidths ? headerWidths(this.cellIndex) : 0;
    return { top: 0, bottom: 0, height: 0, width };
  };

  const send = (message) => window.dispatchEvent(new window.MessageEvent("message", { data: message }));
  send({ type: "init", text, encodingLabel: "UTF-8", fileName: "grid.csv" });
  const scrollTo = (offset) => {
    wrap.scrollTop = offset;
    wrap.dispatchEvent(new window.Event("scroll"));
  };
  return { dom, window, document: window.document, wrap, postedMessages, scrolledCells, send, scrollTo };
}

function csvText(rows, { match = "zzz" } = {}) {
  const lines = ["id,name,note"];
  for (let r = 1; r < rows; r++) {
    lines.push(`${r},name${r},${r % 1000 === 0 ? match : "plain"}`);
  }
  return lines.join("\n");
}

function tbodyRows(document) {
  return Array.from(document.querySelector("tbody").rows);
}

function dataRows(document) {
  return tbodyRows(document).filter((row) => row.className !== "csv-spacer");
}

function spacerHeights(document) {
  const rows = tbodyRows(document);
  const pixels = (row) => Number.parseFloat(row.cells[0].style.height) || 0;
  return { top: pixels(rows[0]), bottom: pixels(rows[rows.length - 1]) };
}

/** The window the grid should hold for a given scroll offset. */
function expectedWindow(total, scrollTop, viewport = VIEWPORT_HEIGHT, rowHeight = ROW_HEIGHT) {
  const visible = Math.ceil(viewport / rowHeight) + OVERSCAN_ROWS * 2;
  if (visible >= total) return { start: 0, end: total };
  const start = Math.max(0, Math.min(total - visible, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS));
  return { start, end: start + visible };
}

test("decorator is idempotent and refuses a bundle it does not recognise", () => {
  const once = decoratedGridHtml();
  assert.equal(gridVirtualization.decorateWebviewHtml(once), once);
  assert.throws(
    () => gridVirtualization.decorateWebviewHtml("<html><body>nothing to patch</body></html>"),
    /Cannot apply grid virtualization patch/
  );
});

test("multiline cells toggle independently and preserve all text when focused and saved", (t) => {
  const value = 'first\nsecond\nthird\n';
  const harness = openGrid('id,note,other\n1,"' + value + '","a\nb"');
  const { dom, window, document, postedMessages, send } = harness;
  t.after(() => dom.window.close());
  const cell = document.querySelector('td[data-r="1"][data-c="1"] .cell');
  const other = document.querySelector('td[data-r="1"][data-c="2"] .cell');
  const toggle = (target) => target.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(cell.textContent, value);
  cell.style.fontSize = '16px';
  const style = window.getComputedStyle(cell);
  assert.ok(Math.abs(parseFloat(style.height) / parseFloat(style.fontSize) - 2.1) < 0.001);
  cell.focus();
  assert.equal(cell.classList.contains('csv-expanded'), false, 'single focus does not expand');
  toggle(cell);
  assert.equal(window.getComputedStyle(cell).height, 'auto');
  toggle(other);
  toggle(cell);
  assert.equal(cell.classList.contains('csv-expanded'), false);
  assert.equal(other.classList.contains('csv-expanded'), true);
  send({ type: 'requestGridData', requestId: 123 });
  assert.equal(postedMessages.filter((message) => message.type === 'edit').length, 0,
    'view toggles and saving an unchanged focused cell must not create edits');
  assert.equal(cell.textContent, value, 'including the final newline');
  const rowHeader = document.querySelector('th[data-rowhead="1"]');
  rowHeader.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.match(document.getElementById('filter').title, /whole table/, 'row numbers do not scope search');
  assert.equal(postedMessages.find((message) => message.requestId === 123).grid[1][1], value);
});

test("expanded row heights survive virtual eviction and do not mislocate distant rows", (t) => {
  const { dom, window, document, scrollTo } = openGrid(csvText(5000).replace('name1,plain', 'name1,"one\ntwo\nthree"'));
  t.after(() => dom.window.close());
  window.HTMLTableRowElement.prototype.getBoundingClientRect = function rect() {
    const height = this.className === 'csv-spacer' ? 0
      : this.querySelector('.csv-expanded') && !this.closest('.csv-measuring') ? 182 : ROW_HEIGHT;
    return { top: 0, bottom: height, height };
  };
  const cell = document.querySelector('td[data-r="1"][data-c="2"] .cell');
  cell.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  scrollTo(200 * ROW_HEIGHT + 156);
  assert.equal(dataRows(document)[0].cells[0].dataset.rowhead, '190');
  assert.equal(spacerHeights(document).top, 190 * ROW_HEIGHT + 156);
  assert.ok(dataRows(document).length < 60);
  scrollTo(0);
  const restored = document.querySelector('td[data-r="1"][data-c="2"] .cell');
  assert.ok(restored.classList.contains('csv-expanded'));
  restored.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  scrollTo(200 * ROW_HEIGHT);
  assert.equal(spacerHeights(document).top, 190 * ROW_HEIGHT);
});

test("only the rows around the viewport reach the DOM, spacers stand in for the rest", () => {
  const total = 5000;
  const { document } = openGrid(csvText(total));
  const window = expectedWindow(total, 0);

  const rendered = dataRows(document);
  assert.equal(rendered.length, window.end - window.start);
  assert.ok(rendered.length < 60, `expected a bounded window, rendered ${rendered.length} rows`);
  assert.equal(tbodyRows(document).length, rendered.length + 2, "exactly two spacer rows");

  // The first rendered row is the header row, which the grid keeps editable.
  assert.equal(rendered[0].cells[0].dataset.rowhead, "0");
  assert.equal(rendered[0].className, "header-row");
  assert.equal(rendered.at(-1).cells[0].dataset.rowhead, String(window.end - 1));

  const { top, bottom } = spacerHeights(document);
  assert.equal(top, 0);
  assert.equal(bottom, (total - window.end) * ROW_HEIGHT);
  assert.equal(top + bottom + rendered.length * ROW_HEIGHT, total * ROW_HEIGHT,
    "the scrollable height must still represent every row");
});

test("scrolling swaps the rendered rows and keeps the scrollable height constant", () => {
  const total = 5000;
  const { document, scrollTo } = openGrid(csvText(total));
  const fullHeight = total * ROW_HEIGHT;

  for (const offset of [0, 3000, 26000, 129480, 0]) {
    scrollTo(offset);
    const window = expectedWindow(total, offset);
    const rendered = dataRows(document);
    assert.equal(rendered.length, window.end - window.start, `row count at ${offset}`);
    assert.equal(rendered[0].cells[0].dataset.rowhead, String(window.start), `first row at ${offset}`);
    assert.equal(rendered.at(-1).cells[0].dataset.rowhead, String(window.end - 1), `last row at ${offset}`);

    const { top, bottom } = spacerHeights(document);
    assert.equal(top, window.start * ROW_HEIGHT, `top spacer at ${offset}`);
    assert.equal(top + bottom + rendered.length * ROW_HEIGHT, fullHeight, `total height at ${offset}`);
  }
});

test("a grid shorter than the viewport renders every row with empty spacers", () => {
  const { document } = openGrid(csvText(6));
  assert.equal(dataRows(document).length, 6);
  assert.deepEqual(spacerHeights(document), { top: 0, bottom: 0 });
});

test("a row height that differs from the estimate is measured and corrected", () => {
  const total = 5000;
  const rowHeight = 41;
  const { document } = openGrid(csvText(total), { rowHeight });
  const window = expectedWindow(total, 0, VIEWPORT_HEIGHT, rowHeight);
  assert.equal(dataRows(document).length, window.end - window.start);
  assert.equal(spacerHeights(document).bottom, (total - window.end) * rowHeight,
    "spacers must use the measured height, not the stylesheet estimate");
});

test("without a measurable viewport every row is rendered", () => {
  const total = 400;
  const { document } = openGrid(csvText(total), { viewport: 0 });
  assert.equal(dataRows(document).length, total);
});

test("search counts every match but only paints the rendered ones", async () => {
  const total = 5000;
  const { document } = openGrid(csvText(total, { match: "needle" }));
  const filter = document.getElementById("filter");
  filter.value = "needle";
  filter.dispatchEvent(new document.defaultView.Event("input"));
  await settleSearch();

  // Rows 1000, 2000, 3000 and 4000 carry the needle.
  assert.equal(document.getElementById("filter-count").textContent, "1/4 results");
  const painted = document.querySelectorAll("td.match").length;
  assert.ok(painted <= dataRows(document).length,
    `painted ${painted} cells for a window of ${dataRows(document).length} rows`);
  assert.equal(document.querySelectorAll("td.match-current").length, 1);
});

test("stepping to a match outside the window scrolls to it and marks it", async () => {
  const total = 5000;
  const { window, document, wrap, scrolledCells } = openGrid(csvText(total, { match: "needle" }));
  const filter = document.getElementById("filter");
  filter.value = "needle";
  filter.dispatchEvent(new window.Event("input"));
  await settleSearch();

  // The first match is row 1000, far below the initial window.
  assert.ok(wrap.scrollTop > 0, "the grid scrolled to the first match");
  assert.equal(scrolledCells.length > 0, true);
  const current = document.querySelector("td.match-current");
  assert.ok(current, "the current match is rendered after scrolling to it");
  assert.equal(current.dataset.r, "1000");

  filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(document.getElementById("filter-count").textContent, "2/4 results");
  assert.equal(document.querySelector("td.match-current").dataset.r, "2000");
  assert.equal(document.querySelectorAll("td.match-current").length, 1,
    "the previous current match must not stay marked");
});

test("selecting a column paints it through the stylesheet across window changes", () => {
  const total = 5000;
  const { window, document, scrollTo } = openGrid(csvText(total));
  document.querySelector('thead th[data-colhead="1"]').dispatchEvent(
    new window.MouseEvent("click", { bubbles: true })
  );
  const rules = () => Array.from(document.styleSheets[0].cssRules).map((rule) => rule.cssText).join("\n");
  assert.match(rules(), /td\[data-c="1"\]/, "the column is painted by a rule, not per-cell classes");

  scrollTo(60000);
  assert.match(rules(), /td\[data-c="1"\]/, "the rule survives a window change");
  assert.equal(document.querySelectorAll("td.sel-col").length, 0,
    "no per-cell selection classes are added");
});

test("sorting reorders the virtual list without rendering every row", () => {
  const total = 3000;
  const lines = ["id,name"];
  for (let r = 1; r < total; r++) lines.push(`${total - r},name${total - r}`);
  const { window, document } = openGrid(lines.join("\n"));

  const header = document.querySelector('thead th[data-colhead="0"]');
  header.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const sorter = document.querySelector('[data-sortcol="0"]');
  sorter.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  const rendered = dataRows(document);
  assert.ok(rendered.length < 60, "sorting must not render the whole file");
  // Ascending by id: the header row first, then the smallest ids.
  const firstData = rendered.find((row) => row.className !== "header-row");
  assert.equal(firstData.cells[1].textContent, "1");
  assert.equal(spacerHeights(document).bottom, (total - rendered.length) * ROW_HEIGHT);
});

test("an edit in progress is committed when scrolling evicts its row", () => {
  const total = 5000;
  const { window, document, postedMessages, scrollTo } = openGrid(csvText(total));
  const td = document.querySelector('td[data-r="5"][data-c="1"]');
  const cell = td.querySelector(".cell");
  cell.focus();
  assert.equal(document.activeElement, cell, "JSDOM must focus the contenteditable cell");
  cell.textContent = "edited";

  const before = postedMessages.length;
  scrollTo(80000);
  assert.equal(document.querySelector('td[data-r="5"][data-c="1"]'), null, "the row was evicted");

  const edits = postedMessages.slice(before).filter((message) => message.type === "edit");
  assert.equal(edits.length, 1, "the pending edit is committed, not lost");
  assert.equal(edits[0].label, "Edit cell B6");
  // The ops come from the JSDOM realm, so compare them as plain data.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(edits[0].redo), { k: "cell", r: 5, c: 1, v: "edited" });
  assert.deepEqual(plain(edits[0].undo), { k: "cell", r: 5, c: 1, v: "name5" });
});

test("an edited cell that stays in the window keeps focus and is not committed twice", () => {
  const total = 5000;
  const { document, postedMessages, scrollTo } = openGrid(csvText(total));
  scrollTo(26000);
  // A row in the middle of the window, so a one-row scroll cannot evict it.
  const td = dataRows(document)[15].querySelector("td[data-c='1']");
  const row = td.dataset.r;
  const cell = td.querySelector(".cell");
  cell.focus();

  const before = postedMessages.length;
  scrollTo(26026);
  const restored = document.querySelector(`td[data-r="${row}"][data-c="1"] .cell`);
  assert.ok(restored, "the row is still inside the window");
  assert.equal(document.activeElement, restored, "focus follows the rebuilt cell");
  assert.equal(postedMessages.slice(before).filter((m) => m.type === "edit").length, 0,
    "an untouched cell must not create an undo entry");
});

test("column widths are pinned so scrolling cannot resize the table", () => {
  const total = 5000;
  // Column 2 is the widest; only its width should be pinned, whatever rows the
  // window happens to hold.
  const widths = (index) => [44, 90, 120, 260][index] || 80;
  const { document, scrollTo } = openGrid(csvText(total), { headerWidths: widths });
  const table = document.querySelector("#grid-wrap table");
  const headerCells = () => Array.from(document.querySelector("thead").rows[0].cells);

  assert.equal(table.style.tableLayout, "fixed");
  assert.deepEqual(headerCells().map((cell) => cell.style.width),
    ["44px", "90px", "120px", "260px"]);

  scrollTo(80000);
  assert.deepEqual(headerCells().map((cell) => cell.style.width),
    ["44px", "90px", "120px", "260px"], "a window change must not resize the columns");
});

test("adding a column re-measures the pinned widths", () => {
  let natural = (index) => [44, 90, 120, 260][index] || 80;
  const { window, document } = openGrid(csvText(400), { headerWidths: (index) => natural(index) });
  assert.deepEqual(Array.from(document.querySelector("thead").rows[0].cells)
    .map((cell) => cell.style.width), ["44px", "90px", "120px", "260px"]);

  natural = (index) => [44, 70, 70, 70, 70][index] || 80;
  document.getElementById("add-col").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(Array.from(document.querySelector("thead").rows[0].cells)
    .map((cell) => cell.style.width), ["44px", "70px", "70px", "70px", "70px"],
    "a new column count must be measured afresh, not read back from the pinned layout");
});

test("loading different content measures its own column widths", () => {
  let natural = (index) => [44, 90, 120, 260][index] || 80;
  const { document, send } = openGrid(csvText(400), { headerWidths: (index) => natural(index) });
  assert.equal(document.querySelector("thead").rows[0].cells[3].style.width, "260px");

  natural = (index) => [44, 50, 60, 70][index] || 80;
  send({ type: "setContent", text: "a,b,c\n1,2,3", encodingLabel: "UTF-8" });
  assert.deepEqual(Array.from(document.querySelector("thead").rows[0].cells)
    .map((cell) => cell.style.width), ["44px", "50px", "60px", "70px"]);
});

test("without measurable layout the table keeps automatic column sizing", () => {
  const { document } = openGrid(csvText(400));
  assert.equal(document.querySelector("#grid-wrap table").style.tableLayout, "");
});

test("read-only mode survives virtual window replacement without moving or rebuilding it on toggle", (t) => {
  const h = openGrid(csvText(10000));
  t.after(() => h.window.close());
  h.scrollTo(26000);
  const first = h.document.querySelector('td[data-r]');
  const row = first.dataset.r;
  const offset = h.wrap.scrollTop;
  h.document.getElementById('edit-mode').click();
  assert.equal(h.wrap.scrollTop, offset);
  assert.equal(h.document.querySelector('td[data-r]'), first, 'toggle only updates the rendered cells');
  h.scrollTo(52000);
  assert.notEqual(h.document.querySelector('td[data-r]').dataset.r, row);
  assert.ok(dataRows(h.document).length < 50);
  assert.ok([...h.document.querySelectorAll('.cell')].every(cell => cell.getAttribute('contenteditable') === 'false'));
  h.document.getElementById('edit-mode').click();
  h.scrollTo(78000);
  assert.ok([...h.document.querySelectorAll('.cell')].every(cell => cell.getAttribute('contenteditable') === 'true'));
  assert.equal(h.postedMessages.filter(m => m.type === 'edit').length, 0);
});
