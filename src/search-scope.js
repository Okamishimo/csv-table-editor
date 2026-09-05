"use strict";

function replaceOnce(source, from, to, description) {
  const occurrences = source.split(from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Cannot add column-scoped search: expected one ${description}, found ${occurrences}.`);
  }
  return source.replace(from, to);
}

function decorateWebviewHtml(html) {
  if (html.includes("function csvHasColumnSearchScope()")) return html;

  let decorated = replaceOnce(
    html,
    '<input id="filter" type="text" placeholder="Filter… (search across all columns)" />',
    '<input id="filter" type="text" placeholder="Find in whole table" />',
    "search input"
  );
  decorated = replaceOnce(
    decorated,
    '    <span class="info" id="filter-count"></span>\n',
    '    <span class="info" id="filter-count"></span>\n' +
      '    <span class="info" id="search-scope"></span>\n',
    "search result counter"
  );
  decorated = replaceOnce(
    decorated,
    `  function setSelection(r, c) {
    sel = { r: r, c: c };
    applySelection();
  }
`,
    `  function setSelection(r, c) {
    const isSameWholeColumn = r < 0 && c >= 0 && sel.r < 0 && sel.c === c;
    sel = isSameWholeColumn ? { r: -1, c: -1 } : { r: r, c: c };
    applySelection();
    updateCsvSearchScope();
    runSearch(false);
  }
`,
    "selection function"
  );
  decorated = replaceOnce(
    decorated,
    `  const filterEl = document.getElementById('filter');
  const filterCountEl = document.getElementById('filter-count');
`,
    `  const filterEl = document.getElementById('filter');
  const filterCountEl = document.getElementById('filter-count');
  const csvSearchScopeEl = document.getElementById('search-scope');

  function csvHasColumnSearchScope() {
    // CSV parsing normalizes every row to grid[0].length, so this stays O(1)
    // even when the editable table contains hundreds of thousands of rows.
    return sel.r < 0 && sel.c >= 0 && Array.isArray(grid[0]) && sel.c < grid[0].length;
  }

  function csvSelectedColumnLabel() {
    const header = grid[headerRow] && grid[headerRow][sel.c];
    return header != null && String(header).trim() ? String(header).trim() : colName(sel.c);
  }

  function updateCsvSearchScope() {
    const scoped = csvHasColumnSearchScope();
    const label = scoped ? csvSelectedColumnLabel() : '';
    filterEl.placeholder = scoped ? 'Find in column ' + label : 'Find in whole table';
    filterEl.title = scoped
      ? 'Searching column ' + label + ' only; click its column header again to search the whole table'
      : 'Searching the whole table; click a column header to limit the search';
    csvSearchScopeEl.textContent = scoped ? 'Column ' + label + ' only' : '';
  }

  updateCsvSearchScope();
`,
    "search element declarations"
  );
  decorated = replaceOnce(
    decorated,
    `    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid[r].length; c++) {
`,
    `    const scopedColumn = csvHasColumnSearchScope() ? sel.c : -1;
    for (let r = 0; r < grid.length; r++) {
      const columnStart = scopedColumn >= 0 ? scopedColumn : 0;
      const columnEnd = scopedColumn >= 0 ? scopedColumn + 1 : grid[r].length;
      for (let c = columnStart; c < columnEnd; c++) {
`,
    "whole-table search loop"
  );
  decorated = replaceOnce(
    decorated,
    `    const sortH = e.target.closest('[data-sortcol]');
    if (sortH) {
`,
    `    const sortH = e.target.closest('[data-sortcol]');
    const columnHead = e.target.closest('th[data-colhead]');
    if (columnHead && !isDelBtn && !sortH) {
      setSelection(-1, +columnHead.dataset.colhead);
      return;
    }
    if (sortH) {
`,
    "column header click handler"
  );
  return decorated;
}

module.exports = { decorateWebviewHtml };
