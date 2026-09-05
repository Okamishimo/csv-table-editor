"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const gridPerformance = require("../src/grid-performance");
const { SEARCH_DEBOUNCE_MS } = gridPerformance;

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
  const bundleModule = new Module(path.join(path.dirname(bundlePath), "extension.grid.js"), module);
  bundleModule.filename = path.join(path.dirname(bundlePath), "extension.grid.js");
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
  return gridPerformance.decorateWebviewHtml(
    require("../src/search-scope").decorateWebviewHtml(
      require("../src/font-settings").decorateWebviewHtml(raw)
    )
  );
}

/** Open the decorated grid in JSDOM and feed it CSV text. */
function openGrid(text) {
  const dom = new JSDOM(decoratedGridHtml(), {
    runScripts: "dangerously",
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({ postMessage() {} });
      window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
    },
  });
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
    data: { type: "init", text, encodingLabel: "UTF-8", fileName: "grid.csv" },
  }));
  return dom;
}

function cellText(document, r, c) {
  const td = document.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
  return td ? td.textContent : null;
}

function selectionRules(document) {
  return Array.from(document.styleSheets[0].cssRules).map((rule) => rule.cssText);
}

test("decorator is idempotent and refuses a bundle it does not recognise", () => {
  const once = decoratedGridHtml();
  assert.equal(gridPerformance.decorateWebviewHtml(once), once);
  assert.throws(
    () => gridPerformance.decorateWebviewHtml("<html><body>nothing to patch</body></html>"),
    /Cannot apply grid performance patch/
  );
});

test("segment-copying parser keeps RFC 4180 semantics", () => {
  const dom = openGrid(
    'A,B,C\r\n"x,y","he said ""hi""","multi\nline"\r\n1,,3\r\n"trailing'
  );
  const document = dom.window.document;

  assert.equal(cellText(document, 0, 0), "A");
  assert.equal(cellText(document, 1, 0), "x,y", "quoted delimiter stays in the cell");
  assert.equal(cellText(document, 1, 1), 'he said "hi"', "doubled quotes collapse to one");
  assert.equal(cellText(document, 1, 2), "multi\nline", "newlines survive inside quotes");
  assert.equal(cellText(document, 2, 1), "", "empty field stays empty");
  assert.equal(cellText(document, 3, 0), "trailing", "unterminated quote runs to the end");
  // Every row is padded to the widest row.
  assert.equal(document.querySelectorAll('tr[class=""] td, tr.header-row td').length % 3, 0);

  dom.window.close();
});

test("HTML-significant characters are still escaped", () => {
  const dom = openGrid("name,markup\nrow,<b>&amp;</b>");
  const document = dom.window.document;
  assert.equal(cellText(document, 1, 1), "<b>&amp;</b>");
  assert.equal(document.querySelectorAll("tbody b").length, 0, "markup must not become elements");
  dom.window.close();
});

test("selecting a row or column paints stylesheet rules, not per-cell classes", () => {
  const rows = ["h0,h1,h2"];
  for (let r = 0; r < 40; r++) rows.push(`a${r},b${r},c${r}`);
  const dom = openGrid(rows.join("\n"));
  const document = dom.window.document;
  const { window } = dom;

  const cell = document.querySelector('td[data-r="5"][data-c="1"] .cell');
  cell.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));

  assert.equal(
    document.querySelectorAll(".sel-row, .sel-col, .sel-active, .sel-head").length,
    0,
    "selection must not touch individual cells"
  );
  const rules = selectionRules(document).join("\n");
  assert.match(rules, /tbody td\[data-c="1"\] \.cell/, "column rule");
  assert.match(rules, /tbody td\[data-r="5"\] \.cell/, "row rule");
  assert.match(rules, /tbody td\[data-r="5"\]\[data-c="1"\]/, "intersection rule");
  assert.match(rules, /thead th\[data-colhead="1"\]/, "column header rule");
  assert.match(rules, /tbody th\.row-actions\[data-rowhead="5"\]/, "row header rule");

  dom.window.close();
});

test("selection falls back to per-cell classes when rules cannot be inserted", () => {
  const rows = ["h0,h1,h2"];
  for (let r = 0; r < 10; r++) rows.push(`a${r},b${r},c${r}`);
  const dom = new JSDOM(decoratedGridHtml(), {
    runScripts: "dangerously",
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({ postMessage() {} });
      window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
      window.CSSStyleSheet.prototype.insertRule = function insertRule() {
        throw new Error("stylesheet is read-only");
      };
    },
  });
  const { window } = dom;
  const document = window.document;
  window.dispatchEvent(new window.MessageEvent("message", {
    data: { type: "init", text: rows.join("\n"), encodingLabel: "UTF-8", fileName: "grid.csv" },
  }));

  document
    .querySelector('td[data-r="4"][data-c="2"] .cell')
    .dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));

  assert.equal(document.querySelectorAll("td.sel-active").length, 1, "intersection cell");
  assert.equal(document.querySelectorAll("td.sel-row").length, 3, "one row of cells");
  assert.equal(document.querySelectorAll("td.sel-col").length, 11, "one cell per rendered row");
  assert.equal(document.querySelectorAll("th.sel-head").length, 2, "row and column headers");

  // Moving the selection clears the previous highlight rather than adding to it.
  document
    .querySelector('td[data-r="6"][data-c="0"] .cell')
    .dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  assert.equal(document.querySelectorAll("td.sel-active").length, 1);
  assert.equal(document.querySelectorAll('td.sel-active[data-r="6"][data-c="0"]').length, 1);

  dom.window.close();
});

test("repeated selections replace their rules instead of accumulating", () => {
  const rows = ["h0,h1,h2"];
  for (let r = 0; r < 30; r++) rows.push(`a${r},b${r},c${r}`);
  const dom = openGrid(rows.join("\n"));
  const document = dom.window.document;
  const { window } = dom;

  const select = (r, c) => document
    .querySelector(`td[data-r="${r}"][data-c="${c}"] .cell`)
    .dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));

  select(3, 0);
  const afterFirst = document.styleSheets[0].cssRules.length;
  for (let r = 4; r < 25; r++) select(r, r % 3);
  assert.equal(
    document.styleSheets[0].cssRules.length,
    afterFirst,
    "one selection's worth of rules, however many cells were clicked"
  );

  // Clearing the selection (clicking the same column header twice) removes them all.
  const columnHead = document.querySelector('th[data-colhead="1"]');
  columnHead.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const withColumnScope = document.styleSheets[0].cssRules.length;
  columnHead.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.ok(
    document.styleSheets[0].cssRules.length < withColumnScope,
    "deselecting drops the rules it added"
  );

  dom.window.close();
});

test("typing coalesces into a single debounced search", async () => {
  const rows = ["name,city"];
  for (let r = 0; r < 50; r++) rows.push(`Alice${r},Taipei`);
  const dom = openGrid(rows.join("\n"));
  const document = dom.window.document;
  const { window } = dom;
  const filter = document.getElementById("filter");

  for (const value of ["A", "Al", "Ali", "Alic", "Alice"]) {
    filter.value = value;
    filter.dispatchEvent(new window.Event("input"));
  }
  assert.equal(
    document.querySelectorAll("tbody td.match").length,
    0,
    "no scan runs while the user is still typing"
  );

  await settleSearch();
  assert.equal(document.querySelectorAll("tbody td.match").length, 50);
  assert.equal(document.getElementById("filter-count").textContent, "1/50 results");

  // Enter must act on what was typed, flushing a still-pending scan.
  filter.value = "Taipei";
  filter.dispatchEvent(new window.Event("input"));
  filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(document.getElementById("filter-count").textContent, "2/50 results");

  dom.window.close();
});

test("match highlights follow the rows after a sort re-render", async () => {
  const rows = ["name,city", "Carol,Osaka", "Alice,Taipei", "Bob,Tokyo", "Alice,Kyoto"];
  const dom = openGrid(rows.join("\n"));
  const document = dom.window.document;
  const { window } = dom;

  const filter = document.getElementById("filter");
  filter.value = "Alice";
  filter.dispatchEvent(new window.Event("input"));
  await settleSearch();
  assert.equal(document.querySelectorAll("tbody td.match").length, 2);

  document
    .querySelector('[data-sortcol="0"]')
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  const matched = Array.from(document.querySelectorAll("tbody td.match"));
  assert.equal(matched.length, 2, "highlights survive the rebuilt tbody");
  assert.deepEqual(
    matched.map((td) => td.dataset.r).sort(),
    ["2", "4"],
    "and stay on the original rows that matched"
  );
  assert.equal(
    document.querySelectorAll("tbody td.match-current").length,
    1,
    "exactly one current match after the re-render"
  );

  dom.window.close();
});

test("clearing the filter removes every highlight", async () => {
  const dom = openGrid("name,city\nAlice,Taipei\nAlice,Tokyo");
  const document = dom.window.document;
  const { window } = dom;
  const filter = document.getElementById("filter");

  filter.value = "Alice";
  filter.dispatchEvent(new window.Event("input"));
  await settleSearch();
  assert.equal(document.querySelectorAll("tbody td.match").length, 2);

  filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(document.querySelectorAll("tbody td.match, tbody td.match-current").length, 0);
  assert.equal(document.getElementById("filter-count").textContent, "");

  dom.window.close();
});
