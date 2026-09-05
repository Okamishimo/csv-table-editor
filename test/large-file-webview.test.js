"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { getLargeFileWebviewHtml } = require("../src/large-file-mode");

function openPreview(t) {
  const postedMessages = [];
  const scrolledCells = [];
  const dom = new JSDOM(getLargeFileWebviewHtml(), {
    runScripts: "dangerously",
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({ postMessage: (message) => postedMessages.push(message) });
      window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() { scrolledCells.push(this); };
    },
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  return {
    window,
    document: window.document,
    postedMessages,
    scrolledCells,
    send: (data) => window.dispatchEvent(new window.MessageEvent("message", { data })),
    click: (element) => element.dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
  };
}

function cellColumnRule(document) {
  return Array.from(document.styleSheets[0].cssRules)
    .find((rule) => rule.selectorText.includes("#table-wrap tbody tr > td:nth-child("));
}

test("paging preserves visible row geometry through eviction, fractional heights and scroll clamping", (t) => {
  for (const mode of ["append", "prepend"]) {
    const { window, document, send, postedMessages } = openPreview(t);
    const body = document.querySelector("tbody");
    const wrap = document.getElementById("table-wrap");
    const head = document.querySelector("thead");
    const height = (row) => 20 + Number(row.dataset.rowNumber) % 7 / 4;
    const contentHeight = () => 26 + Array.from(body.rows).reduce((sum, row) => sum + height(row), 0);
    let scrollTop = 0;
    let measuredRows = 0;
    Object.defineProperties(wrap, {
      clientHeight: { get: () => 260 },
      scrollHeight: { get: contentHeight },
      // JSDOM has no layout. Model the browser's clamp when eviction shrinks
      // the document, so compensation cannot assume the old scrollTop survives.
      scrollTop: {
        get() { scrollTop = Math.max(0, Math.min(scrollTop, contentHeight() - 260)); return scrollTop; },
        set(value) { scrollTop = Math.max(0, Math.min(value, contentHeight() - 260)); },
      },
    });
    wrap.getBoundingClientRect = () => ({ top: 0, bottom: 260, height: 260 });
    head.getBoundingClientRect = () => ({ top: 0, bottom: 26, height: 26 });
    window.HTMLTableRowElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      measuredRows++;
      let top = 26 - wrap.scrollTop;
      for (const row of body.rows) {
        if (row === this) break;
        top += height(row);
      }
      return { top, bottom: top + height(this), height: height(this) };
    };
    const page = (pageNumber, pageMode, length = 100) => send({
      type: "page", mode: pageMode, header: ["Row"],
      rows: Array.from({ length }, (_, index) => [String(2 + (pageNumber - 1) * 100 + index)]),
      pageNumber, startRow: 2 + (pageNumber - 1) * 100,
      endRow: 1 + (pageNumber - 1) * 100 + length,
      done: length < 100, truncatedCells: 0, truncatedColumns: false,
    });
    for (let number = 6; number <= 10; number++) {
      page(number, number === 6 ? "replace" : "append", mode === "prepend" && number === 10 ? 50 : 100);
    }
    wrap.scrollLeft = 40;
    if (mode === "append") wrap.scrollTop = wrap.scrollHeight - wrap.clientHeight - 20;
    else {
      wrap.scrollTop = 220;
      wrap.dispatchEvent(new window.Event("scroll"));
      wrap.scrollTop = 180;
    }
    wrap.dispatchEvent(new window.Event("scroll"));
    assert.equal(postedMessages.at(-1).type, mode === "append" ? "nextPage" : "previousPage");
    const visibleRow = Array.from(body.rows).find((row) => row.getBoundingClientRect().bottom > 26);
    const topBefore = visibleRow.getBoundingClientRect().top;
    const rowNumber = visibleRow.dataset.rowNumber;
    const requestCount = postedMessages.length;
    measuredRows = 0;
    send({ type: "loading", loading: true });
    if (mode === "append") page(11, "append", 50);
    else page(5, "prepend");
    send({ type: "loading", loading: false });
    assert.ok(measuredRows <= 12, "finding and restoring the visible anchor must not scan all 500 row rectangles");
    assert.equal(visibleRow.isConnected, true);
    assert.ok(Math.abs(visibleRow.getBoundingClientRect().top - topBefore) < 0.001,
      `visible row ${rowNumber} must keep its pixel offset after ${mode}`);
    assert.equal(wrap.scrollLeft, 40);
    assert.equal(body.rows.length, mode === "append" ? 450 : 500);
    assert.match(document.querySelector("style").textContent, /#table-wrap \{[^}]*overflow-anchor: none/);
    // Browsers emit this event asynchronously after our scrollTop adjustment.
    wrap.dispatchEvent(new window.Event("scroll"));
    assert.equal(postedMessages.length, requestCount, "compensation must not trigger another page request");
    if (mode === "prepend") {
      wrap.scrollTop = 0;
      wrap.dispatchEvent(new window.Event("scroll"));
      assert.deepEqual(JSON.parse(JSON.stringify(postedMessages.at(-1))), { type: "previousPage", beforePage: 5 });
    }
  }
});

test("loading pages refreshes search matches without scrolling back to the current match", async (t) => {
  const { window, document, send, scrolledCells } = openPreview(t);
  const page = { type: "page", mode: "replace", header: ["Name"],
    rows: [["Alice"], ["Alice"]], pageNumber: 2, startRow: 102, endRow: 103,
    done: false, truncatedCells: 0, truncatedColumns: false };
  send(page);
  const filter = document.getElementById("filter");
  filter.value = "Alice";
  filter.dispatchEvent(new window.Event("input"));
  await new Promise((resolve) => window.setTimeout(resolve, 175));
  filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const scrollCount = scrolledCells.length;
  for (const mode of ["append", "prepend"]) {
    send({ ...page, mode, rows: [["Alice"]], pageNumber: mode === "append" ? 3 : 1,
      startRow: mode === "append" ? 202 : 2, endRow: mode === "append" ? 202 : 2 });
    assert.equal(scrolledCells.length, scrollCount, "loading must not call scrollIntoView for a search match");
  }
  assert.equal(document.querySelectorAll("td.match").length, 4);
  assert.equal(document.querySelectorAll("td.match-current").length, 1);
  assert.equal(document.getElementById("filter-count").textContent, "2/4 results");
  filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(scrolledCells.length, scrollCount + 1, "explicit match navigation still scrolls");
  assert.equal(document.getElementById("filter-count").textContent, "3/4 results");
});

test("preview cell clicks highlight both axes with bounded DOM changes and one stylesheet rule", (t) => {
  const { window, document, send, click, postedMessages } = openPreview(t);
  const page = { type: "page", mode: "replace", header: ["Name", "City"],
    rows: [["Alice", "Taipei"], ["Bob", "Tokyo"]], pageNumber: 1, startRow: 2, endRow: 3,
    done: false, truncatedCells: 0, truncatedColumns: false };
  send(page);
  const body = document.querySelector("tbody");
  const first = body.rows[0];
  const second = body.rows[1];
  const headers = document.querySelector("thead tr").cells;
  const ruleCount = document.styleSheets[0].cssRules.length;
  click(first.cells[1]);
  assert.equal(first.classList.contains("highlighted-row"), true);
  assert.equal(first.cells[1].classList.contains("highlighted-cell"), true);
  assert.deepEqual(Array.from(document.querySelectorAll(cellColumnRule(document).selectorText)),
    [headers[1], first.cells[1], second.cells[1]], "the column includes its header and every loaded data cell");
  assert.equal(cellColumnRule(document).style.getPropertyValue("background"), "var(--vscode-list-inactiveSelectionBackground)");
  const activeRule = Array.from(document.styleSheets[0].cssRules)
    .find((rule) => rule.selectorText === "td.highlighted-cell");
  assert.equal(activeRule.style.getPropertyValue("outline"), "2px solid var(--vscode-focusBorder)");
  // JSDOM drops !important on var() background shorthands in its CSSOM.
  // Check the actual nonce-approved declaration sent to the browser instead.
  assert.match(document.querySelector("style[nonce]").textContent,
    /td\.match \{ background: var\(--vscode-editor-findMatchBackground\) !important;/,
    "search highlights must take precedence over the cell's row and column");

  // Any row-list scan fails, and only the old/new row and active cell may change.
  const observer = new window.MutationObserver(() => {});
  observer.observe(body, { attributes: true, subtree: true });
  Object.defineProperty(body, "rows", { configurable: true, get() { throw new Error("selection must not scan rows"); } });
  try {
    for (let index = 0; index < 20; index++) {
      click(index % 2 ? first.cells[1] : second.cells[2]);
      assert.ok(observer.takeRecords().length <= 4, "selection must not decorate each cell in a column");
    }
  } finally {
    delete body.rows;
    observer.disconnect();
  }
  click(second.cells[2]);
  click(second.cells[2]);
  assert.equal(document.styleSheets[0].cssRules.length, ruleCount + 1, "repeated clicks reuse a single column rule");
  assert.equal(document.querySelectorAll("td.highlighted-cell").length, 1);
  assert.equal(document.querySelectorAll("tr.highlighted-row").length, 1);
  assert.equal(first.cells[1].classList.contains("highlighted-cell"), false);
  assert.deepEqual(Array.from(document.querySelectorAll(cellColumnRule(document).selectorText)),
    [headers[2], first.cells[2], second.cells[2]]);
  assert.equal(document.querySelectorAll('[contenteditable="true"]').length, 0);

  click(second.cells[0]);
  assert.equal(second.classList.contains("highlighted-row"), true, "row-number clicks keep only the row highlight");
  assert.equal(document.querySelectorAll("td.highlighted-cell").length, 0);
  assert.equal(cellColumnRule(document), undefined);
  click(first.cells[1]);
  click(headers[2]);
  assert.equal(document.querySelectorAll("tr.highlighted-row, td.highlighted-cell").length, 0);
  assert.equal(cellColumnRule(document), undefined, "column-header clicks clear the cell axes");
  assert.equal(document.getElementById("search-scope").textContent, "Column City only");
  click(first.cells[1]);
  assert.equal(document.querySelectorAll(".search-column").length, 0, "cell clicks cancel the previous whole-column highlight");
  assert.equal(document.getElementById("filter").placeholder, "Find in loaded rows");
  assert.deepEqual(Array.from(document.querySelectorAll(cellColumnRule(document).selectorText)),
    [headers[1], first.cells[1], second.cells[1]], "only the clicked cell's column remains highlighted");
  send({ ...page, mode: "append", pageNumber: 2, startRow: 102, endRow: 103 });
  assert.equal(document.querySelectorAll(".search-column").length, 0, "new pages must not restore the cancelled selection");
  send(page);
  assert.equal(first.classList.contains("highlighted-row"), false);
  assert.equal(first.cells[1].classList.contains("highlighted-cell"), false);
  assert.equal(cellColumnRule(document), undefined, "replacement releases the detached cell and its column");
  assert.deepEqual(JSON.parse(JSON.stringify(postedMessages)), [{ type: "ready" }]);
});

test("preview cell axes extend to cached pages and clear when the active page is evicted in either direction", (t) => {
  for (const mode of ["append", "prepend"]) {
    const { document, send, click, postedMessages } = openPreview(t);
    let selectedRow;
    const pageNumbers = mode === "append" ? [1, 2, 3, 4, 5, 6] : [6, 5, 4, 3, 2, 1];
    for (const [index, pageNumber] of pageNumbers.entries()) {
      send({ type: "page", mode: index ? mode : "replace", header: ["Name", "City"],
        rows: Array.from({ length: 100 }, (_, row) => ["row " + row, "city " + row]),
        pageNumber, startRow: 2 + (pageNumber - 1) * 100, endRow: 1 + pageNumber * 100,
        done: false, truncatedCells: 0, truncatedColumns: false });
      if (index === 0) {
        selectedRow = document.querySelector("tbody tr");
        click(selectedRow.cells[2]);
      } else if (index < 5) {
        assert.equal(selectedRow.classList.contains("highlighted-row"), true);
        assert.equal(selectedRow.cells[2].classList.contains("highlighted-cell"), true);
        assert.equal(document.querySelectorAll(cellColumnRule(document).selectorText).length, (index + 1) * 100 + 1,
          "the new cached rows inherit the column highlight automatically");
      }
    }
    assert.equal(document.querySelectorAll("tbody tr").length, 500);
    assert.equal(document.querySelectorAll("tr.highlighted-row, td.highlighted-cell").length, 0);
    assert.equal(selectedRow.isConnected, false);
    assert.equal(selectedRow.classList.contains("highlighted-row"), false);
    assert.equal(selectedRow.cells[2].classList.contains("highlighted-cell"), false);
    assert.equal(cellColumnRule(document), undefined, "an evicted selection must not leave a stale highlighted column");
    assert.deepEqual(JSON.parse(JSON.stringify(postedMessages)), [{ type: "ready" }]);
  }
});

test("preview cell clicks cancel column scope once and preserve whole-window search and navigation", async (t) => {
  for (const scoped of [false, true]) {
    const { window, document, send, click, postedMessages, scrolledCells } = openPreview(t);
    send({ type: "page", mode: "replace", header: ["Name", "City"],
      rows: [["Alice", "Alice"], ["Alice", "Tokyo"]], pageNumber: 1, startRow: 2, endRow: 3,
      done: false, truncatedCells: 0, truncatedColumns: false });
    if (scoped) click(document.querySelector('thead th[data-column-index="0"]'));
    const filter = document.getElementById("filter");
    filter.value = "Alice";
    filter.dispatchEvent(new window.Event("input"));
    await new Promise((resolve) => window.setTimeout(resolve, 175));
    filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const matches = Array.from(document.querySelectorAll("td.match"));
    assert.equal(matches.length, scoped ? 2 : 3);
    const current = document.querySelector("td.match-current");
    const scrollBefore = scrolledCells.length;
    const rows = document.querySelector("tbody").rows;
    const tableWrap = document.getElementById("table-wrap");
    tableWrap.scrollTop = 120;
    tableWrap.scrollLeft = 40;
    click(rows[0].cells[1]);
    assert.equal(document.querySelectorAll(".search-column").length, 0, "even clicking the scoped column cancels its whole-column selection");
    const expectedCurrent = scoped ? rows[0].cells[1] : current;
    const expectedIndex = scoped ? 1 : 2;
    click(rows[1].cells[2]); // Subsequent clicks only move the cell highlight.
    click(rows[1].cells[2]);
    await new Promise((resolve) => window.setTimeout(resolve, 175));
    assert.equal(document.getElementById("search-scope").textContent, "");
    assert.equal(filter.placeholder, "Find in loaded rows");
    assert.equal(filter.value, "Alice");
    assert.equal(filter.disabled, false);
    assert.deepEqual(Array.from(document.querySelectorAll("td.match")),
      [rows[0].cells[1], rows[0].cells[2], rows[1].cells[1]], "search includes matches outside the cancelled scope");
    assert.equal(document.querySelector("td.match-current"), expectedCurrent);
    assert.equal(document.getElementById("filter-count").textContent, `${expectedIndex}/3 results`);
    assert.equal(scrolledCells.length, scrollBefore);
    assert.equal(tableWrap.scrollTop, 120);
    assert.equal(tableWrap.scrollLeft, 40);
    assert.equal(rows[1].cells[2].classList.contains("highlighted-cell"), true);
    for (const modifier of ["ctrlKey", "metaKey"]) {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "f", [modifier]: true, bubbles: true }));
      assert.equal(document.activeElement, filter);
      filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
      assert.equal(document.getElementById("filter-count").textContent, `${scoped ? 3 : 1}/3 results`);
      filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      assert.equal(document.querySelector("td.match-current"), expectedCurrent);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(postedMessages)), [{ type: "ready" }]);
  }
});

test("large-file preview highlights whole rows without per-cell changes or clearing column selection", () => {
  const postedMessages = [];
  const dom = new JSDOM(getLargeFileWebviewHtml(), {
    runScripts: "dangerously",
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({ postMessage: (message) => postedMessages.push(message) });
      window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
    },
  });
  const { window } = dom;
  const document = window.document;
  const send = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }));
  const page = { type: "page", mode: "replace", header: ["Name", "City"],
    rows: [["Alice", "Taipei"], ["Bob", "Tokyo"]], pageNumber: 1, startRow: 2, endRow: 3,
    done: false, truncatedCells: 0, truncatedColumns: false };
  send(page);
  const click = (element) => element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const firstRow = document.querySelector("tbody tr");
  const secondRow = firstRow.nextElementSibling;
  const column = document.querySelector('thead th[data-column-index="1"]');
  click(firstRow.cells[0]);
  assert.equal(firstRow.classList.contains("highlighted-row"), true);
  assert.equal(document.querySelectorAll("tbody tr.highlighted-row").length, 1);
  assert.equal(document.querySelectorAll("tbody td.highlighted-row").length, 0);
  assert.match(document.querySelector("style").textContent, /tbody tr\.highlighted-row > td,\s*tbody tr\.highlighted-row > th/);
  click(secondRow.cells[0]);
  assert.equal(firstRow.classList.contains("highlighted-row"), false);
  assert.equal(secondRow.classList.contains("highlighted-row"), true);
  click(secondRow.cells[0]);
  assert.equal(document.querySelectorAll("tbody tr.highlighted-row").length, 1);
  click(firstRow.cells[0]);
  click(column);
  assert.equal(firstRow.classList.contains("highlighted-row"), false);
  assert.equal(column.classList.contains("search-column"), true);
  click(firstRow.cells[0]);
  assert.equal(document.querySelectorAll(".search-column").length, 3, "row highlighting preserves the selected column");
  assert.equal(firstRow.classList.contains("highlighted-row"), true);
  send({ ...page, mode: "append", pageNumber: 2, startRow: 102, endRow: 103 });
  assert.equal(firstRow.classList.contains("highlighted-row"), true, "appending preserves the highlighted row");
  send(page);
  assert.equal(document.querySelectorAll("tbody tr.highlighted-row").length, 0, "replacing the window clears the old row highlight");
  assert.equal(firstRow.classList.contains("highlighted-row"), false, "the detached row is no longer tracked or highlighted");
  assert.deepEqual(JSON.parse(JSON.stringify(postedMessages)), [{ type: "ready" }], "selection never requests another page");
  dom.window.close();
});

test("row highlighting preserves whole-window and column-scoped search results and keyboard navigation", async (t) => {
  for (const columnIndex of [null, 0]) {
    const postedMessages = [];
    let scrollCount = 0;
    const dom = new JSDOM(getLargeFileWebviewHtml(), {
      runScripts: "dangerously",
      beforeParse(window) {
        window.acquireVsCodeApi = () => ({ postMessage: (message) => postedMessages.push(message) });
        window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() { scrollCount++; };
      },
    });
    t.after(() => dom.window.close());
    const { window } = dom;
    const document = window.document;
    window.dispatchEvent(new window.MessageEvent("message", { data: {
      type: "page", mode: "replace", header: ["Name", "City"],
      rows: [["Alice", "Alice"], ["Alice", "Tokyo"]], pageNumber: 1, startRow: 2, endRow: 3,
      done: false, truncatedCells: 0, truncatedColumns: false,
    } }));
    const click = (element) => element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    if (columnIndex !== null) click(document.querySelector(`thead th[data-column-index="${columnIndex}"]`));
    const filter = document.getElementById("filter");
    filter.value = "Alice";
    filter.dispatchEvent(new window.Event("input"));
    await new Promise((resolve) => window.setTimeout(resolve, 175));
    const expectedCount = columnIndex === null ? 3 : 2;
    const matches = Array.from(document.querySelectorAll("td.match"));
    assert.equal(matches.length, expectedCount);
    filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.equal(document.getElementById("filter-count").textContent, `2/${expectedCount} results`);
    const current = document.querySelector("td.match-current");
    const scope = document.getElementById("search-scope").textContent;
    const placeholder = filter.placeholder;
    const scrollBefore = scrollCount;
    const rows = document.querySelector("tbody").rows;
    click(rows[0].cells[0]);
    click(rows[1].cells[0]);
    await new Promise((resolve) => window.setTimeout(resolve, 175));
    assert.equal(document.getElementById("search-scope").textContent, scope);
    assert.equal(filter.placeholder, placeholder);
    assert.equal(filter.value, "Alice");
    assert.equal(filter.disabled, false, "row highlighting never disables search");
    assert.deepEqual(Array.from(document.querySelectorAll("td.match")), matches);
    assert.equal(document.querySelector("td.match-current"), current);
    assert.equal(document.getElementById("filter-count").textContent, `2/${expectedCount} results`);
    assert.equal(scrollCount, scrollBefore, "highlighting must not rerun search or move to a match");
    assert.equal(rows[1].classList.contains("highlighted-row"), true);
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    assert.equal(document.activeElement, filter);
    filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    assert.equal(document.getElementById("filter-count").textContent, `1/${expectedCount} results`);
    filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.equal(document.querySelector("td.match-current"), current);
    assert.deepEqual(JSON.parse(JSON.stringify(postedMessages)), [{ type: "ready" }]);
  }
});

test("large-file webview is read-only, searches loaded rows and automatically appends pages", async () => {
  const postedMessages = [];
  const dom = new JSDOM(getLargeFileWebviewHtml(), {
    runScripts: "dangerously",
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({
        postMessage: (message) => postedMessages.push(message),
      });
    },
  });
  const { window } = dom;
  const document = window.document;
  const send = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }));

  assert.equal(JSON.stringify(postedMessages), JSON.stringify([{ type: "ready" }]));
  send({
    type: "init",
    fileName: "huge.csv",
    fileSize: "1839.9 MiB",
    encodingLabel: "Chinese (Big5)",
    delimiterLabel: "Comma",
    fontFamily: '"Microsoft JhengHei", "Noto Sans TC", sans-serif',
    canEnableEditing: false,
    hardLimit: 511,
  });
  send({
    type: "page",
    mode: "replace",
    header: ["Name", "City"],
    rows: [["Alice", "Taipei"], ["Alice", "Kaohsiung"]],
    pageNumber: 1,
    startRow: 2,
    endRow: 3,
    done: false,
    truncatedCells: 0,
    truncatedColumns: false,
  });

  assert.equal(document.getElementById("file-size").textContent, "1839.9 MiB");
  assert.equal(document.getElementById("font-family"), null);
  assert.match(document.documentElement.style.getPropertyValue("--csv-table-font-family"), /Microsoft JhengHei/);
  assert.equal(document.getElementById("edit").hidden, true);
  assert.equal(document.getElementById("notice"), null);
  assert.equal(document.getElementById("restart"), null);
  assert.equal(document.getElementById("next"), null);
  assert.equal(document.getElementById("text"), null);
  assert.equal(document.getElementById("readonly").textContent, "Read-only preview");
  assert.match(document.getElementById("readonly").title, /unavailable above 511 MiB/);
  assert.equal(document.querySelectorAll("tbody tr").length, 2);
  assert.equal(document.getElementById("status").textContent, "Rows 2–3");

  send({ type: "fontFamily", fontFamily: "My Installed Font, monospace" });
  assert.equal(postedMessages.length, 1, "font changes come from VS Code settings, not the webview");
  assert.match(document.documentElement.style.getPropertyValue("--csv-table-font-family"), /My Installed Font/);

  document.getElementById("table-wrap").scrollTop = 1;
  document.getElementById("table-wrap").dispatchEvent(new window.Event("scroll"));
  assert.equal(
    JSON.stringify(postedMessages.at(-1)),
    JSON.stringify({ type: "nextPage", afterPage: 1 })
  );

  const filter = document.getElementById("filter");
  filter.value = "Alice";
  filter.dispatchEvent(new window.Event("input"));
  await new Promise((resolve) => window.setTimeout(resolve, 175));
  assert.equal(document.querySelectorAll("tbody td.match").length, 2);
  assert.equal(document.getElementById("filter-count").textContent, "1/2 results");
  filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(document.getElementById("filter-count").textContent, "2/2 results");
  filter.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "Enter", shiftKey: true, bubbles: true,
  }));
  assert.equal(document.getElementById("filter-count").textContent, "1/2 results");

  const cityColumn = document.querySelector('thead th[data-column-index="1"]');
  cityColumn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(document.querySelectorAll("tbody td.match").length, 0);
  assert.equal(document.getElementById("search-scope").textContent, "Column City only");
  assert.equal(filter.placeholder, "Find in column City");
  assert.equal(cityColumn.classList.contains("search-column"), true);
  assert.equal(document.querySelectorAll("tbody td.search-column").length, 2);

  cityColumn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(document.querySelectorAll("tbody td.match").length, 2);
  assert.equal(document.getElementById("search-scope").textContent, "");
  assert.equal(filter.placeholder, "Find in loaded rows");

  document.querySelector("tbody th.row-number")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(filter.placeholder, "Find in loaded rows", "row numbers never scope search");
  assert.equal(document.getElementById("search-scope").textContent, "");

  send({
    type: "page",
    mode: "append",
    header: ["Name", "City"],
    rows: [["Carol", "Tainan"]],
    pageNumber: 2,
    startRow: 102,
    endRow: 102,
    done: true,
    truncatedCells: 0,
    truncatedColumns: false,
  });
  assert.equal(document.querySelectorAll("tbody tr").length, 3, "automatic pages append to the rolling window");
  assert.match(document.getElementById("status").textContent, /End/);
  dom.window.close();
});

test("large-file webview keeps a bounded rolling row window", () => {
  const dom = new JSDOM(getLargeFileWebviewHtml(), {
    runScripts: "dangerously",
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({ postMessage() {} });
    },
  });
  const { window } = dom;
  const document = window.document;
  const send = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }));

  for (let page = 0; page < 6; page += 1) {
    const startRow = 2 + page * 100;
    send({
      type: "page",
      mode: page === 0 ? "replace" : "append",
      header: ["Row"],
      rows: Array.from({ length: 100 }, (_, index) => [String(startRow + index)]),
      pageNumber: page + 1,
      startRow,
      endRow: startRow + 99,
      done: page === 5,
      truncatedCells: 0,
      truncatedColumns: false,
    });
  }

  const rows = document.querySelectorAll("tbody tr");
  assert.equal(rows.length, 500);
  assert.equal(rows[0].dataset.rowNumber, "102");
  assert.equal(rows[rows.length - 1].dataset.rowNumber, "601");
  assert.equal(document.getElementById("status").textContent, "Rows 102–601 · End");
  dom.window.close();
});

test("large-file webview does not cascade page requests without another user scroll", async () => {
  const postedMessages = [];
  const dom = new JSDOM(getLargeFileWebviewHtml(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({
        postMessage: (message) => postedMessages.push(message),
      });
    },
  });
  const { window } = dom;
  const document = window.document;
  const send = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }));

  send({
    type: "page",
    mode: "replace",
    header: ["Name"],
    rows: [["Alice"]],
    pageNumber: 1,
    startRow: 2,
    endRow: 2,
    done: false,
    truncatedCells: 0,
    truncatedColumns: false,
  });
  const filter = document.getElementById("filter");
  filter.value = "no matches";
  filter.dispatchEvent(new window.Event("input"));
  await new Promise((resolve) => window.setTimeout(resolve, 175));

  document.getElementById("table-wrap").scrollTop = 1;
  document.getElementById("table-wrap").dispatchEvent(new window.Event("scroll"));
  await new Promise((resolve) => window.setTimeout(resolve, 25));
  send({ type: "loading", loading: true });
  send({
    type: "page",
    mode: "append",
    header: ["Name"],
    rows: [["Bob"]],
    pageNumber: 2,
    startRow: 102,
    endRow: 102,
    done: false,
    truncatedCells: 0,
    truncatedColumns: false,
  });
  send({ type: "loading", loading: false });
  document.getElementById("table-wrap").dispatchEvent(new window.Event("scroll"));
  await new Promise((resolve) => window.setTimeout(resolve, 25));

  assert.equal(postedMessages.filter((message) => message.type === "nextPage").length, 1);
  dom.window.close();
});

test("large-file webview loads cached pages when scrolling upward", () => {
  const postedMessages = [];
  const dom = new JSDOM(getLargeFileWebviewHtml(), {
    runScripts: "dangerously",
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({
        postMessage: (message) => postedMessages.push(message),
      });
    },
  });
  const { window } = dom;
  const document = window.document;
  const send = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }));
  const tableWrap = document.getElementById("table-wrap");

  for (let page = 0; page < 6; page += 1) {
    if (page === 5) tableWrap.scrollTop = 500;
    const startRow = 2 + page * 100;
    const pageLength = page === 5 ? 50 : 100;
    send({
      type: "page",
      mode: page === 0 ? "replace" : "append",
      header: ["Row"],
      rows: Array.from({ length: pageLength }, (_, index) => [String(startRow + index)]),
      pageNumber: page + 1,
      startRow,
      endRow: startRow + pageLength - 1,
      done: page === 5,
      truncatedCells: 0,
      truncatedColumns: false,
    });
  }

  tableWrap.scrollTop = 0;
  tableWrap.dispatchEvent(new window.Event("scroll"));
  assert.equal(
    JSON.stringify(postedMessages.at(-1)),
    JSON.stringify({ type: "previousPage", beforePage: 2 })
  );

  send({ type: "loading", loading: true });
  send({
    type: "page",
    mode: "prepend",
    header: ["Row"],
    rows: Array.from({ length: 100 }, (_, index) => [String(index + 2)]),
    pageNumber: 1,
    startRow: 2,
    endRow: 101,
    done: false,
    truncatedCells: 0,
    truncatedColumns: false,
  });
  send({ type: "loading", loading: false });

  const rows = document.querySelectorAll("tbody tr");
  assert.equal(rows.length, 500);
  assert.equal(rows[0].dataset.rowNumber, "2");
  assert.equal(rows[rows.length - 1].dataset.rowNumber, "501");
  dom.window.close();
});

test("large-file preview attaches cell tooltips only on hover", () => {
  const dom = new JSDOM(getLargeFileWebviewHtml(), {
    runScripts: "dangerously",
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({ postMessage() {} });
    },
  });
  const { window } = dom;
  const document = window.document;
  const send = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }));

  send({
    type: "page",
    mode: "replace",
    header: ["Name", "Note"],
    rows: [["Alice", "a note"], ["Bob", "x".repeat(300)]],
    pageNumber: 1,
    startRow: 2,
    endRow: 3,
    done: true,
    truncatedCells: 0,
    truncatedColumns: false,
  });

  const cells = document.querySelectorAll("tbody td");
  assert.equal(
    Array.from(cells).filter((cell) => cell.hasAttribute("title")).length,
    0,
    "rendering must not write a title on every cell"
  );

  const hover = (element) => element.dispatchEvent(
    new window.MouseEvent("mouseover", { bubbles: true })
  );
  hover(cells[0]);
  assert.equal(cells[0].title, "Alice", "hovering attaches the tooltip");
  assert.equal(cells[1].hasAttribute("title"), false, "neighbours stay untouched");

  const longCell = Array.from(cells).find((cell) => cell.textContent.length === 300);
  hover(longCell);
  assert.equal(longCell.hasAttribute("title"), false, "over-long values stay untitled");

  dom.window.close();
});

test("large-file preview evicts a whole page without re-reading the live row list", () => {
  const dom = new JSDOM(getLargeFileWebviewHtml(), {
    runScripts: "dangerously",
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({ postMessage() {} });
    },
  });
  const { window } = dom;
  const document = window.document;
  const send = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }));
  const page = (pageNumber, mode) => send({
    type: "page",
    mode,
    header: ["Name"],
    rows: Array.from({ length: 100 }, (_, i) => ["row " + pageNumber + "-" + i]),
    pageNumber,
    startRow: 2 + (pageNumber - 1) * 100,
    endRow: 1 + pageNumber * 100,
    done: false,
    truncatedCells: 0,
    truncatedColumns: false,
  });

  page(1, "replace");
  const firstRow = document.querySelector("tbody tr");
  firstRow.cells[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(firstRow.classList.contains("highlighted-row"), true);
  for (let pageNumber = 2; pageNumber <= 6; pageNumber++) page(pageNumber, "append");

  const rows = document.querySelectorAll("tbody tr");
  assert.equal(rows.length, 500, "the window stays bounded at five pages");
  const pageNumbers = new Set(Array.from(rows, (row) => row.dataset.pageNumber));
  assert.deepEqual(
    Array.from(pageNumbers).sort(),
    ["2", "3", "4", "5", "6"],
    "the oldest page is evicted whole, newest pages kept"
  );
  assert.equal(firstRow.classList.contains("highlighted-row"), false, "eviction clears the detached highlighted row");
  assert.equal(document.querySelectorAll("tbody tr.highlighted-row").length, 0);

  dom.window.close();
});
