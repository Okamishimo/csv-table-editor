"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { getLargeFileWebviewHtml } = require("../src/large-file-mode");

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
  for (let pageNumber = 2; pageNumber <= 6; pageNumber++) page(pageNumber, "append");

  const rows = document.querySelectorAll("tbody tr");
  assert.equal(rows.length, 500, "the window stays bounded at five pages");
  const pageNumbers = new Set(Array.from(rows, (row) => row.dataset.pageNumber));
  assert.deepEqual(
    Array.from(pageNumbers).sort(),
    ["2", "3", "4", "5", "6"],
    "the oldest page is evicted whole, newest pages kept"
  );

  dom.window.close();
});
