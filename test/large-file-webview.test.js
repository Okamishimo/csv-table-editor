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

/**
 * The matches the host's scan would report for the rows a test has loaded,
 * in the order the scan reports them: from `fromRow` down, then wrapping.
 */
function scanMatches(document, query, { column = -1, fromRow = 0 } = {}) {
  const needle = query.toLowerCase();
  const ahead = [];
  const wrapped = [];
  for (const row of document.getElementById("rows").rows) {
    const rowNumber = Number(row.dataset.rowNumber);
    const page = Number(row.dataset.pageNumber);
    const first = column >= 0 ? column : 0;
    const last = column >= 0 ? column + 1 : row.cells.length - 1;
    for (let c = first; c < last; c++) {
      const cell = row.cells[c + 1];
      if (!cell || !cell.textContent.toLowerCase().includes(needle)) continue;
      (rowNumber >= fromRow ? ahead : wrapped).push({ r: rowNumber, c, p: page });
    }
  }
  return ahead.concat(wrapped);
}

/** Answer the webview's latest whole-file search the way the host would. */
function answerSearch(postedMessages, send, matches, options = {}) {
  const request = postedMessages.filter((message) => message.type === "searchFile").at(-1);
  assert.ok(request, "the webview must ask the host to search the file");
  send({
    type: "searchMatches",
    query: request.query,
    matches,
    done: options.done !== false,
    truncated: options.truncated === true,
    scannedRows: options.scannedRows === undefined ? 200 : options.scannedRows,
  });
  return request;
}

/** Click the element matching a selector, the way the reader would. */
function click(document, window, selector) {
  document.querySelector(selector).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function cellColumnRule(document) {
  return Array.from(document.styleSheets[0].cssRules)
    .find((rule) => rule.selectorText.includes("#table-wrap #rows tr > td:nth-child("));
}

test("paging preserves visible row geometry through eviction, fractional heights and scroll clamping", (t) => {
  for (const mode of ["append", "prepend"]) {
    const { window, document, send, postedMessages } = openPreview(t);
    const body = document.getElementById("rows");
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
  const { window, document, send, scrolledCells, postedMessages } = openPreview(t);
  const page = { type: "page", mode: "replace", header: ["Name"],
    rows: [["Alice"], ["Alice"]], pageNumber: 2, startRow: 102, endRow: 103,
    done: false, truncatedCells: 0, truncatedColumns: false };
  send(page);
  const filter = document.getElementById("filter");
  filter.value = "Alice";
  filter.dispatchEvent(new window.Event("input"));
  await new Promise((resolve) => window.setTimeout(resolve, 175));
  // The host reports every match in the file, including rows not loaded yet.
  answerSearch(postedMessages, send, [
    { r: 102, c: 0, p: 2 }, { r: 103, c: 0, p: 2 },
    { r: 202, c: 0, p: 3 }, { r: 2, c: 0, p: 1 },
  ]);
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
  const body = document.getElementById("rows");
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
  assert.equal(document.getElementById("filter").placeholder, "Find in file");
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
        selectedRow = document.querySelector("#rows tr");
        click(selectedRow.cells[2]);
      } else if (index < 5) {
        assert.equal(selectedRow.classList.contains("highlighted-row"), true);
        assert.equal(selectedRow.cells[2].classList.contains("highlighted-cell"), true);
        assert.equal(document.querySelectorAll(cellColumnRule(document).selectorText).length, (index + 1) * 100 + 1,
          "the new cached rows inherit the column highlight automatically");
      }
    }
    assert.equal(document.querySelectorAll("#rows tr").length, 500);
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
    answerSearch(postedMessages, send,
      scanMatches(document, "Alice", { column: scoped ? 0 : -1, fromRow: 2 }));
    filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const matches = Array.from(document.querySelectorAll("td.match"));
    assert.equal(matches.length, scoped ? 2 : 3);
    const current = document.querySelector("td.match-current");
    const scrollBefore = scrolledCells.length;
    const rows = document.getElementById("rows").rows;
    const tableWrap = document.getElementById("table-wrap");
    tableWrap.scrollTop = 120;
    tableWrap.scrollLeft = 40;
    click(rows[0].cells[1]);
    // Cancelling the scope is a different result set, so the file is read again.
    if (scoped) answerSearch(postedMessages, send, scanMatches(document, "Alice", { fromRow: 2 }));
    assert.equal(document.querySelectorAll(".search-column").length, 0, "even clicking the scoped column cancels its whole-column selection");
    const expectedCurrent = scoped ? rows[0].cells[1] : current;
    const expectedIndex = scoped ? 1 : 2;
    click(rows[1].cells[2]); // Subsequent clicks only move the cell highlight.
    click(rows[1].cells[2]);
    await new Promise((resolve) => window.setTimeout(resolve, 175));
    assert.equal(document.getElementById("search-scope").textContent, "");
    assert.equal(filter.placeholder, "Find in file");
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
    assert.deepEqual(postedMessages.filter((message) => message.type === "searchFile")
      .map((message) => message.column), scoped ? [0, -1] : [-1],
      "only a scope change starts another scan");
    for (const modifier of ["ctrlKey", "metaKey"]) {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "f", [modifier]: true, bubbles: true }));
      assert.equal(document.activeElement, filter);
      filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
      assert.equal(document.getElementById("filter-count").textContent, `${scoped ? 3 : 1}/3 results`);
      filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      assert.equal(document.querySelector("td.match-current"), expectedCurrent);
    }
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
  const firstRow = document.querySelector("#rows tr");
  const secondRow = firstRow.nextElementSibling;
  const column = document.querySelector('thead th[data-column-index="1"]');
  click(firstRow.cells[0]);
  assert.equal(firstRow.classList.contains("highlighted-row"), true);
  assert.equal(document.querySelectorAll("#rows tr.highlighted-row").length, 1);
  assert.equal(document.querySelectorAll("#rows td.highlighted-row").length, 0);
  assert.match(document.querySelector("style").textContent, /#rows tr\.highlighted-row > td,\s*#rows tr\.highlighted-row > th/);
  click(secondRow.cells[0]);
  assert.equal(firstRow.classList.contains("highlighted-row"), false);
  assert.equal(secondRow.classList.contains("highlighted-row"), true);
  click(secondRow.cells[0]);
  assert.equal(document.querySelectorAll("#rows tr.highlighted-row").length, 1);
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
  assert.equal(document.querySelectorAll("#rows tr.highlighted-row").length, 0, "replacing the window clears the old row highlight");
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
    answerSearch(postedMessages, (data) =>
      window.dispatchEvent(new window.MessageEvent("message", { data })),
      scanMatches(document, "Alice", { column: columnIndex === null ? -1 : columnIndex, fromRow: 2 }));
    const expectedCount = columnIndex === null ? 3 : 2;
    const matches = Array.from(document.querySelectorAll("td.match"));
    assert.equal(matches.length, expectedCount);
    filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.equal(document.getElementById("filter-count").textContent, `2/${expectedCount} results`);
    const current = document.querySelector("td.match-current");
    const scope = document.getElementById("search-scope").textContent;
    const placeholder = filter.placeholder;
    const scrollBefore = scrollCount;
    const rows = document.getElementById("rows").rows;
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
    assert.deepEqual(postedMessages.map((message) => message.type), ["ready", "searchFile"],
      "row highlighting never starts another scan");
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
  assert.equal(document.querySelectorAll("#rows tr").length, 2);
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
  answerSearch(postedMessages, send, scanMatches(document, "Alice", { fromRow: 2 }));
  assert.equal(document.querySelectorAll("#rows td.match").length, 2);
  assert.equal(document.getElementById("filter-count").textContent, "1/2 results");
  filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(document.getElementById("filter-count").textContent, "2/2 results");
  filter.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "Enter", shiftKey: true, bubbles: true,
  }));
  assert.equal(document.getElementById("filter-count").textContent, "1/2 results");

  const cityColumn = document.querySelector('thead th[data-column-index="1"]');
  cityColumn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(document.querySelectorAll("#rows td.match").length, 0);
  assert.equal(document.getElementById("search-scope").textContent, "Column City only");
  assert.equal(filter.placeholder, "Find in column City");
  assert.equal(cityColumn.classList.contains("search-column"), true);
  assert.equal(document.querySelectorAll("#rows td.search-column").length, 2);

  cityColumn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(document.querySelectorAll("#rows td.match").length, 2);
  assert.equal(document.getElementById("search-scope").textContent, "");
  assert.equal(filter.placeholder, "Find in file");

  document.querySelector("#rows th.row-number")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(filter.placeholder, "Find in file", "row numbers never scope search");
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
  assert.equal(document.querySelectorAll("#rows tr").length, 3, "automatic pages append to the rolling window");
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

  const rows = document.querySelectorAll("#rows tr");
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

  const rows = document.querySelectorAll("#rows tr");
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

  const cells = document.querySelectorAll("#rows td");
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
  const firstRow = document.querySelector("#rows tr");
  firstRow.cells[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(firstRow.classList.contains("highlighted-row"), true);
  for (let pageNumber = 2; pageNumber <= 6; pageNumber++) page(pageNumber, "append");

  const rows = document.querySelectorAll("#rows tr");
  assert.equal(rows.length, 500, "the window stays bounded at five pages");
  const pageNumbers = new Set(Array.from(rows, (row) => row.dataset.pageNumber));
  assert.deepEqual(
    Array.from(pageNumbers).sort(),
    ["2", "3", "4", "5", "6"],
    "the oldest page is evicted whole, newest pages kept"
  );
  assert.equal(firstRow.classList.contains("highlighted-row"), false, "eviction clears the detached highlighted row");
  assert.equal(document.querySelectorAll("#rows tr.highlighted-row").length, 0);

  dom.window.close();
});

test("typing asks the host to read the whole file from where the reader is", async (t) => {
  const { window, document, send, postedMessages } = openPreview(t);
  send({ type: "page", mode: "replace", header: ["Name", "City"],
    rows: [["Alice", "Taipei"], ["Bob", "Tokyo"]], pageNumber: 4, startRow: 302, endRow: 303,
    done: false, truncatedCells: 0, truncatedColumns: false });

  const filter = document.getElementById("filter");
  filter.value = "  Alice  ";
  filter.dispatchEvent(new window.Event("input"));
  assert.equal(postedMessages.filter((m) => m.type === "searchFile").length, 0, "typing is debounced");
  await new Promise((resolve) => window.setTimeout(resolve, 175));

  assert.deepEqual(JSON.parse(JSON.stringify(postedMessages.at(-1))),
    { type: "searchFile", query: "Alice", column: -1, fromRow: 302 },
    "the scan starts at the first loaded row so results continue from here");

  // Scoping to a column restarts the scan for that column only.
  click(document, window, 'thead th[data-column-index="1"]');
  assert.equal(postedMessages.at(-1).column, 1);
});

test("clearing the query calls off a running scan exactly once", async (t) => {
  const { window, document, send, postedMessages } = openPreview(t);
  send({ type: "page", mode: "replace", header: ["Name"], rows: [["Alice"]],
    pageNumber: 1, startRow: 2, endRow: 2, done: true, truncatedCells: 0, truncatedColumns: false });
  const filter = document.getElementById("filter");
  filter.value = "Alice";
  filter.dispatchEvent(new window.Event("input"));
  await new Promise((resolve) => window.setTimeout(resolve, 175));
  answerSearch(postedMessages, send, [{ r: 2, c: 0, p: 1 }]);

  filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(document.getElementById("filter-count").textContent, "");
  assert.equal(document.querySelectorAll("td.match").length, 0);
  const cancels = postedMessages.filter((message) => message.type === "cancelSearch");
  assert.equal(cancels.length, 1);

  filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(postedMessages.filter((message) => message.type === "cancelSearch").length, 1,
    "there is nothing to call off a second time");
});

test("progress is shown while the file is still being read", async (t) => {
  const { window, document, send, postedMessages } = openPreview(t);
  send({ type: "page", mode: "replace", header: ["Name"], rows: [["Alice"]],
    pageNumber: 1, startRow: 2, endRow: 2, done: false, truncatedCells: 0, truncatedColumns: false });
  const filter = document.getElementById("filter");
  filter.value = "Alice";
  filter.dispatchEvent(new window.Event("input"));
  await new Promise((resolve) => window.setTimeout(resolve, 175));
  const count = document.getElementById("filter-count");

  send({ type: "searchStarted", query: "Alice" });
  assert.equal(count.textContent, "Searching… 0 rows");

  answerSearch(postedMessages, send, [], { done: false, scannedRows: 120000 });
  assert.equal(count.textContent, "Searching… 120,000 rows");

  answerSearch(postedMessages, send, [{ r: 2, c: 0, p: 1 }], { done: false, scannedRows: 300000 });
  assert.equal(count.textContent, "1/1 results · searching… 300,000 rows");

  answerSearch(postedMessages, send, [{ r: 900, c: 0, p: 10 }], { done: true, scannedRows: 400000 });
  assert.equal(count.textContent, "1/2 results");

  answerSearch(postedMessages, send, [], { done: true, truncated: true, scannedRows: 400000 });
  assert.match(count.textContent, /\/2\+ results$/, "a capped scan says the total is a floor");
});

test("results from a superseded query are ignored", async (t) => {
  const { window, document, send, postedMessages } = openPreview(t);
  send({ type: "page", mode: "replace", header: ["Name"], rows: [["Alice"]],
    pageNumber: 1, startRow: 2, endRow: 2, done: true, truncatedCells: 0, truncatedColumns: false });
  const filter = document.getElementById("filter");
  filter.value = "Alice";
  filter.dispatchEvent(new window.Event("input"));
  await new Promise((resolve) => window.setTimeout(resolve, 175));

  send({ type: "searchMatches", query: "Bob", matches: [{ r: 2, c: 0, p: 1 }],
    done: true, truncated: false, scannedRows: 10 });
  assert.equal(document.getElementById("filter-count").textContent, "Searching… 0 rows",
    "a late report for an older query must not become the result set");
  assert.equal(postedMessages.filter((message) => message.type === "gotoMatch").length, 0);
});

test("a match outside the loaded window loads its page and is revealed there", async (t) => {
  const { window, document, send, postedMessages, scrolledCells } = openPreview(t);
  send({ type: "page", mode: "replace", header: ["Name"], rows: [["plain"], ["plain"]],
    pageNumber: 1, startRow: 2, endRow: 3, done: false, truncatedCells: 0, truncatedColumns: false });
  const filter = document.getElementById("filter");
  filter.value = "needle";
  filter.dispatchEvent(new window.Event("input"));
  await new Promise((resolve) => window.setTimeout(resolve, 175));

  // The only match is far away, on a page the reader has never seen.
  answerSearch(postedMessages, send, [{ r: 5002, c: 0, p: 51 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(postedMessages.at(-1))),
    { type: "gotoMatch", page: 51, row: 5002, column: 0 });
  assert.equal(document.getElementById("filter-count").textContent, "1/1 results");

  const scrollsBefore = scrolledCells.length;
  send({ type: "page", mode: "replace", header: ["Name"], rows: [["needle"], ["plain"]],
    pageNumber: 51, startRow: 5002, endRow: 5003, done: false,
    truncatedCells: 0, truncatedColumns: false, focus: { row: 5002, column: 0 } });

  const current = document.querySelector("td.match-current");
  assert.ok(current, "the match is marked once its page arrives");
  assert.equal(current.textContent, "needle");
  assert.equal(current.parentElement.dataset.rowNumber, "5002");
  assert.equal(scrolledCells.length, scrollsBefore + 1, "the reader is taken to it");
  assert.equal(document.getElementById("filter-count").textContent, "1/1 results");
});

test("navigation wraps from the last match back to the first", async (t) => {
  const { window, document, send, postedMessages } = openPreview(t);
  send({ type: "page", mode: "replace", header: ["Name"], rows: [["needle"], ["needle"]],
    pageNumber: 1, startRow: 2, endRow: 3, done: false, truncatedCells: 0, truncatedColumns: false });
  const filter = document.getElementById("filter");
  filter.value = "needle";
  filter.dispatchEvent(new window.Event("input"));
  await new Promise((resolve) => window.setTimeout(resolve, 175));
  // Two matches here, one far below: the scan reports them in reading order.
  answerSearch(postedMessages, send,
    [{ r: 2, c: 0, p: 1 }, { r: 3, c: 0, p: 1 }, { r: 900, c: 0, p: 10 }]);

  const count = document.getElementById("filter-count");
  assert.equal(count.textContent, "1/3 results");
  const next = () => filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  next();
  assert.equal(count.textContent, "2/3 results");
  next();
  assert.equal(count.textContent, "3/3 results");
  assert.equal(postedMessages.at(-1).type, "gotoMatch", "the third match is on another page");
  next();
  assert.equal(count.textContent, "1/3 results", "past the end, navigation wraps to the first match");

  filter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
  assert.equal(count.textContent, "3/3 results", "and backwards from the first to the last");
});

const ROW_HEIGHT = 20;
const HEAD_HEIGHT = 26;
const VIEWPORT = 400;

/**
 * Open the preview with a measurable viewport. JSDOM has no layout, so the
 * scroller and row heights are modelled; without them the preview falls back to
 * describing only the loaded window.
 */
function openMeasuredPreview(t) {
  const harness = openPreview(t);
  const { window, document } = harness;
  const wrap = document.getElementById("table-wrap");
  let scrollTop = 0;
  Object.defineProperties(wrap, {
    clientHeight: { get: () => VIEWPORT, configurable: true },
    scrollTop: {
      get: () => scrollTop,
      set(value) { scrollTop = Math.max(0, value); },
      configurable: true,
    },
  });
  window.HTMLTableRowElement.prototype.getBoundingClientRect = function rect() {
    const height = this.parentElement && this.parentElement.id === "rows" ? ROW_HEIGHT : 0;
    return { top: 0, bottom: height, height };
  };
  document.querySelector("thead").getBoundingClientRect = () => (
    { top: 0, bottom: HEAD_HEIGHT, height: HEAD_HEIGHT }
  );

  const page = (pageNumber, mode, extra = {}) => harness.send({
    type: "page", mode, header: ["Name", "City"],
    rows: Array.from({ length: 100 }, (_, index) => {
      const row = 2 + (pageNumber - 1) * 100 + index;
      return [`name ${row}`, `city ${row}`];
    }),
    pageNumber, startRow: 2 + (pageNumber - 1) * 100, endRow: 101 + (pageNumber - 1) * 100,
    done: false, truncatedCells: 0, truncatedColumns: false, ...extra,
  });
  const index = (totalRows) => harness.send({
    type: "fileIndex", totalRows, complete: true, indexedBytes: 1000, size: 1000,
  });
  const spacer = (id) => Number.parseFloat(
    document.getElementById(id).rows[0].cells[0].style.height
  ) || 0;
  const scrollTo = (offset) => {
    wrap.scrollTop = offset;
    wrap.dispatchEvent(new window.Event("scroll"));
  };
  const offsetOfRow = (row) => (row - 2) * ROW_HEIGHT + HEAD_HEIGHT;
  return { ...harness, wrap, page, index, spacer, scrollTo, offsetOfRow };
}

test("once the file is counted, placeholders carry the rows that are not loaded", (t) => {
  const { document, page, index, spacer } = openMeasuredPreview(t);
  page(1, "replace");
  assert.equal(spacer("space-above"), 0, "no total yet, so nothing to stand in for");
  assert.equal(spacer("space-below"), 0);

  index(10000);
  assert.equal(spacer("space-above"), 0, "the window starts at the first row");
  // Rows 102..10001 are not loaded; the placeholder carries their height.
  assert.equal(spacer("space-below"), (10001 - 101) * ROW_HEIGHT);
  assert.match(document.getElementById("status").textContent, /Rows 2–101 of 10,000/);
});

test("evicted rows become placeholder height, so nothing moves and the scrollbar holds", (t) => {
  const { document, page, index, spacer, wrap } = openMeasuredPreview(t);
  page(1, "replace");
  index(10000);
  for (let pageNumber = 2; pageNumber <= 6; pageNumber++) page(pageNumber, "append");

  const rows = document.getElementById("rows").rows;
  assert.equal(rows.length, 500, "the rolling window is still bounded");
  assert.equal(rows[0].dataset.rowNumber, "102", "the first page was evicted");

  // The evicted page is now height above the window rather than rows in it.
  assert.equal(spacer("space-above"), 100 * ROW_HEIGHT);
  assert.equal(spacer("space-below"), (10001 - 601) * ROW_HEIGHT);
  const content = spacer("space-above") + spacer("space-below") + rows.length * ROW_HEIGHT;
  assert.equal(content, 10000 * ROW_HEIGHT, "the scroller always spans the whole file");
  assert.equal(wrap.scrollTop, 0, "growing the placeholder above must not shift the view");
});

test("dragging the scrollbar far away loads that part of the file and stays there", (t) => {
  const { document, page, index, scrollTo, offsetOfRow, postedMessages, spacer } =
    openMeasuredPreview(t);
  page(1, "replace");
  index(10000);

  scrollTo(offsetOfRow(5000));
  assert.deepEqual(JSON.parse(JSON.stringify(postedMessages.at(-1))),
    { type: "gotoRow", row: 5000 }, "the reader is asking for row 5000, not the next page");

  // The host answers with the page holding that row and asks to stay put.
  page(50, "replace", { keepScroll: true });
  const rows = document.getElementById("rows").rows;
  assert.equal(rows[0].dataset.rowNumber, "4902");
  assert.equal(document.getElementById("table-wrap").scrollTop, offsetOfRow(5000),
    "a jump the reader made must not be thrown back to the top");
  assert.equal(spacer("space-above"), (4902 - 2) * ROW_HEIGHT);
  assert.match(document.getElementById("status").textContent, /of 10,000/);
});

test("scrolling inside the loaded window fetches neighbours rather than jumping", (t) => {
  const { send, page, index, scrollTo, offsetOfRow, postedMessages } = openMeasuredPreview(t);
  page(1, "replace");
  index(10000);
  for (const pageNumber of [2, 3]) page(pageNumber, "append");
  const clearPending = () => send({ type: "loading", loading: false });

  // Well inside the window: 51 rows of loaded data still lie below the viewport.
  scrollTo(offsetOfRow(250));
  assert.equal(postedMessages.at(-1).type, "ready", "a scroll with room to spare fetches nothing");

  // Close enough to the bottom of the window that the next page is wanted.
  scrollTo(offsetOfRow(255));
  assert.deepEqual(JSON.parse(JSON.stringify(postedMessages.at(-1))),
    { type: "nextPage", afterPage: 3 }, "the neighbour is paged in, not jumped to");

  clearPending();
  scrollTo(offsetOfRow(4));
  assert.equal(postedMessages.at(-1).type, "nextPage",
    "page 1 is already loaded, so there is nothing above to fetch");
});

test("scrolling up from a window that starts mid-file pages backwards", (t) => {
  const { send, page, index, scrollTo, offsetOfRow, postedMessages, wrap } = openMeasuredPreview(t);
  page(1, "replace");
  index(10000);

  // Drag far away, and let the host answer the way it does for a jump.
  scrollTo(offsetOfRow(1905));
  assert.deepEqual(JSON.parse(JSON.stringify(postedMessages.at(-1))),
    { type: "gotoRow", row: 1905 });
  page(20, "replace", { keepScroll: true });
  send({ type: "loading", loading: false });
  assert.equal(wrap.scrollTop, offsetOfRow(1905), "the jump landed where the reader dragged");
  assert.equal(postedMessages.at(-1).type, "gotoRow",
    "the window covers where they are, so nothing more is fetched");

  // Now edge towards the top of that window.
  scrollTo(offsetOfRow(1904));
  assert.deepEqual(JSON.parse(JSON.stringify(postedMessages.at(-1))),
    { type: "previousPage", beforePage: 20 });
});

test("a drag that outruns the answer is reconciled once the answer arrives", (t) => {
  const { send, page, index, scrollTo, offsetOfRow, postedMessages, wrap } = openMeasuredPreview(t);
  page(1, "replace");
  index(10000);

  // The reader drags to row 3000; that request goes out.
  scrollTo(offsetOfRow(3000));
  assert.deepEqual(JSON.parse(JSON.stringify(postedMessages.at(-1))),
    { type: "gotoRow", row: 3000 });

  // They keep dragging while it is in flight, so the next positions are dropped.
  send({ type: "loading", loading: true });
  scrollTo(offsetOfRow(7000));
  assert.equal(postedMessages.at(-1).row, 3000, "one request is in flight at a time");

  // The stale answer arrives and does not cover where they ended up.
  page(30, "replace", { keepScroll: true });
  send({ type: "loading", loading: false });

  assert.deepEqual(JSON.parse(JSON.stringify(postedMessages.at(-1))),
    { type: "gotoRow", row: 7000 }, "so the preview fetches where they actually stopped");
  assert.equal(wrap.scrollTop, offsetOfRow(7000), "without moving them again");
});

test("while a scan sweeps the file the view follows it, until the reader takes over", async (t) => {
  const { window, document, send, page, index, scrollTo, offsetOfRow, postedMessages, wrap } =
    openMeasuredPreview(t);
  page(1, "replace");
  index(10000);

  const filter = document.getElementById("filter");
  filter.value = "nothing-matches";
  filter.dispatchEvent(new window.Event("input"));
  await new Promise((resolve) => window.setTimeout(resolve, 175));
  assert.equal(postedMessages.at(-1).type, "searchFile");

  // The host shows the pages the scan is passing.
  page(30, "replace", { follow: true });
  assert.equal(document.getElementById("rows").rows[0].dataset.rowNumber, "2902");
  assert.equal(wrap.scrollTop, offsetOfRow(2902), "the view moves to where the scan has reached");

  page(60, "replace", { follow: true });
  assert.equal(wrap.scrollTop, offsetOfRow(5902));

  // The reader scrolling is them taking over.
  scrollTo(offsetOfRow(5910));
  const held = wrap.scrollTop;
  page(90, "replace", { follow: true });
  assert.equal(wrap.scrollTop, held, "a followed page is ignored once the reader has taken over");
  assert.equal(document.getElementById("rows").rows[0].dataset.rowNumber, "5902",
    "and the window they were looking at stays");
});

test("finding a match stops the view chasing the scan", async (t) => {
  const { window, document, send, page, index, postedMessages, wrap, offsetOfRow } =
    openMeasuredPreview(t);
  page(1, "replace");
  index(10000);
  const filter = document.getElementById("filter");
  filter.value = "name 50";
  filter.dispatchEvent(new window.Event("input"));
  await new Promise((resolve) => window.setTimeout(resolve, 175));

  answerSearch(postedMessages, send, [{ r: 50, c: 0, p: 1 }], { done: false, scannedRows: 900 });
  const settled = wrap.scrollTop;
  page(70, "replace", { follow: true });
  assert.equal(wrap.scrollTop, settled, "a result is more interesting than the sweep");
  assert.equal(document.getElementById("rows").rows[0].dataset.rowNumber, "2",
    "the reader keeps looking at the match, not the scan");
});

test("counting progress is shown until the total is known", (t) => {
  const { document, send, page } = openMeasuredPreview(t);
  page(1, "replace");
  send({ type: "fileIndex", totalRows: 0, complete: false, indexedBytes: 250, size: 1000 });
  assert.match(document.getElementById("status").textContent, /counting rows 25%/);
  send({ type: "fileIndex", totalRows: 4321, complete: true, indexedBytes: 1000, size: 1000 });
  assert.match(document.getElementById("status").textContent, /Rows 2–101 of 4,321/);
});
