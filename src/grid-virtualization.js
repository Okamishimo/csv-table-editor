"use strict";

/**
 * Row virtualization for the editable-grid webview.
 *
 * The shipped grid renders every row of the file. A 14 MiB CSV (200,000 rows
 * by 8 columns) becomes a 194 MiB HTML string and roughly 3.6 million elements,
 * because each cell is a `<td>` wrapping a contenteditable `<div>`. That is
 * rebuilt in full on every sort, delete and content change, so the editable
 * grid cannot reach anything close to the 64 MiB default of
 * `csvTableEditor.maxFileSizeMB`.
 *
 * This module renders only the rows near the viewport and stands two spacer
 * rows in for the rest, so the scrollbar keeps representing the whole file.
 * Collapsed rows reserve one and a half lines. Explicitly expanded cells add
 * sparse height corrections to the measured base height and spacer arithmetic.
 *
 * It runs last in the decorator chain, so its anchors are the text produced by
 * `font-settings`, `search-scope` and `grid-performance`. In particular it
 * relies on `grid-performance`'s row index, tracked highlight collections and
 * stylesheet-driven selection, all of which already tolerate a partially
 * rendered table.
 *
 * When the viewport cannot be measured (no layout, as in JSDOM) the window
 * covers every row, so the grid falls back to the original behavior.
 */

const MARKER = "function csvWindowRange()";
const OVERSCAN_ROWS = 10;
const ESTIMATED_ROW_HEIGHT = 26;
const multiline = require("./multiline-cells");

function replaceOnce(source, from, to, description) {
  const occurrences = source.split(from).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Cannot apply grid virtualization patch: expected one ${description}, found ${occurrences}.`
    );
  }
  return source.replace(from, to);
}

function decorateWebviewHtml(html) {
  if (html.includes(MARKER)) return html;

  let decorated = html;

  // ---- 1. Spacer styling in the nonce-approved stylesheet ------------------
  decorated = replaceOnce(
    decorated,
    "  #grid-wrap { overflow: auto; height: calc(100vh - 37px); }",
    [
      "  /* overflow-anchor: the browser would otherwise try to compensate for the",
      "     rows this grid swaps in and out, fighting the spacer arithmetic. */",
      "  #grid-wrap { overflow: auto; overflow-anchor: none; height: calc(100vh - 37px); }",
      "  /* Stand-ins for the rows outside the rendered window. Their height is",
      "     set through the CSSOM, which the style-src nonce policy allows. */",
      "  tr.csv-spacer td { padding: 0; border: 0; min-width: 0; height: 0; }",
      multiline.editableCss,
    ].join("\n"),
    "grid scroller rule"
  );

  // ---- 2. The windowing machinery -----------------------------------------
  decorated = replaceOnce(
    decorated,
    "  function render() {\n    const cols = grid[0] ? grid[0].length : 0;\n",
    [
      "  const csvGridWrapEl = document.getElementById('grid-wrap');",
      "  const csvTableEl = csvGridWrapEl.querySelector('table');",
      "",
      `  const CSV_OVERSCAN_ROWS = ${OVERSCAN_ROWS};`,
      "",
      "  /** Grid row indices in the order tbody shows them: preamble rows, the",
      "   *  header row, then the data rows in their current sort order. */",
      "  let csvDisplayOrder = [];",
      "  /** The inverse of csvDisplayOrder, for scrolling to a known grid row. */",
      "  let csvDisplayPositions = new Map();",
      "  /** Column count of the last render, so the window can rebuild rows. */",
      "  let csvRenderedColumns = 0;",
      "  /** Bounds of the rendered slice of csvDisplayOrder. */",
      "  let csvRenderedStart = -1;",
      "  let csvRenderedEnd = -1;",
      `  let csvRowHeight = ${ESTIMATED_ROW_HEIGHT};`,
      "  let csvWindowFrame = 0;",
      "  /** Matching columns per grid row, so repainting a window costs the",
      "   *  rendered rows rather than every match in the file. */",
      "  let csvMatchColumns = new Map();",
      "  /** The cell that held focus when the window was last rebuilt. */",
      "  let csvFocusedCell = null;",
      "  /** Column widths measured once from the first window. Automatic table",
      "   *  layout sizes columns from the rows it can see, so without this the",
      "   *  whole table would resize every time scrolling swapped the rows. */",
      "  let csvColumnWidths = null;",
      multiline.createRowLayout.toString(),
      multiline.readEditableCell.toString(),
      multiline.installEditableMultiline.toString(),
      "  const csvMultiline = installEditableMultiline();",
      "",
      "  function lockCsvColumnWidths() {",
      "    const headerRowEl = theadEl.rows[0];",
      "    if (!headerRowEl || !headerRowEl.cells.length) { return; }",
      "    const cells = headerRowEl.cells;",
      "    if (!csvColumnWidths || csvColumnWidths.length !== cells.length) {",
      "      // Measure the natural layout before pinning it, so a re-measure after",
      "      // a column is added or removed does not just read back the old widths.",
      "      csvTableEl.style.tableLayout = '';",
      "      const widths = [];",
      "      let measured = false;",
      "      for (let i = 0; i < cells.length; i++) {",
      "        const width = cells[i].getBoundingClientRect().width;",
      "        if (width > 0) { measured = true; }",
      "        widths.push(width);",
      "      }",
      "      // Without layout there is nothing to pin; leave the table automatic.",
      "      if (!measured) { return; }",
      "      csvColumnWidths = widths;",
      "    }",
      "    for (let i = 0; i < cells.length; i++) {",
      "      cells[i].style.width = csvColumnWidths[i] + 'px';",
      "    }",
      "    csvTableEl.style.tableLayout = 'fixed';",
      "  }",
      "",
      "  function rebuildCsvDisplayOrder() {",
      "    csvMultiline.reset();",
      "    csvDisplayOrder = [];",
      "    for (let r = 0; r < headerRow; r++) { csvDisplayOrder.push(r); }",
      "    csvDisplayOrder.push(headerRow);",
      "    for (let k = 0; k < viewOrder.length; k++) { csvDisplayOrder.push(viewOrder[k]); }",
      "    csvDisplayPositions = new Map();",
      "    for (let i = 0; i < csvDisplayOrder.length; i++) {",
      "      csvDisplayPositions.set(csvDisplayOrder[i], i);",
      "    }",
      "  }",
      "",
      "  function csvRowClass(r) {",
      "    if (r < headerRow) { return 'preamble-row'; }",
      "    return r === headerRow ? 'header-row' : '';",
      "  }",
      "",
      "  /** The slice of csvDisplayOrder worth having in the DOM right now. */",
      "  function csvWindowRange() {",
      "    const total = csvDisplayOrder.length;",
      "    const viewport = csvGridWrapEl.clientHeight;",
      "    // Without usable layout there is nothing to window against, so render",
      "    // everything rather than guess and show a blank table.",
      "    if (!viewport || !csvRowHeight) { return { start: 0, end: total }; }",
      "    const visible = Math.ceil(viewport / csvRowHeight) + CSV_OVERSCAN_ROWS * 2;",
      "    if (visible >= total) { return { start: 0, end: total }; }",
      "    const first = csvMultiline.layout.indexAt(csvGridWrapEl.scrollTop, total, csvRowHeight) - CSV_OVERSCAN_ROWS;",
      "    const start = Math.max(0, Math.min(total - visible, first));",
      "    return { start: start, end: start + visible };",
      "  }",
      "",
      "  function measureCsvRowHeight() {",
      "    csvTableEl.classList.add('csv-measuring');",
      "    const rows = tbodyEl.rows;",
      "    for (let i = 0; i < rows.length; i++) {",
      "      if (rows[i].className === 'csv-spacer') { continue; }",
      "      const height = rows[i].getBoundingClientRect().height;",
      "      if (height > 0) { csvTableEl.classList.remove('csv-measuring'); return height; }",
      "    }",
      "    csvTableEl.classList.remove('csv-measuring');",
      "    return 0;",
      "  }",
      "  function updateCsvSpacers() {",
      "    const rows = tbodyEl.rows;",
      "    if (rows.length < 2) return;",
      "    const offset = (position) => csvMultiline.layout.offset(position, csvRowHeight);",
      "    rows[0].cells[0].style.height = offset(csvRenderedStart) + 'px';",
      "    rows[rows.length - 1].cells[0].style.height =",
      "      (offset(csvDisplayOrder.length) - offset(csvRenderedEnd)) + 'px';",
      "  }",
      "",
      "  /** Rebuild tbody for one window. Highlights are the caller's business,",
      "   *  exactly as they were when render() replaced the whole table. */",
      "  function paintCsvWindow(range) {",
      "    let body = '<tr class=\"csv-spacer\"><td></td></tr>';",
      "    for (let i = range.start; i < range.end; i++) {",
      "      const r = csvDisplayOrder[i];",
      "      body += rowHtml(r, csvRenderedColumns, csvRowClass(r));",
      "    }",
      "    body += '<tr class=\"csv-spacer\"><td></td></tr>';",
      "    tbodyEl.innerHTML = body;",
      "    csvRenderedStart = range.start;",
      "    csvRenderedEnd = range.end;",
      "    // The tbody was replaced: rebuild the row index and drop the element",
      "    // references the previous highlights were holding.",
      "    rebuildCsvRowIndex();",
      "    csvMultiline.restore();",
      "    csvMultiline.measure();",
      "    updateCsvSpacers();",
      "    csvHighlightedMatches = [];",
      "    csvHighlightedSelection = [];",
      "    csvCurrentMatchCell = null;",
      "  }",
      "",
      "  /** Paint, then correct the row height once if the real one differs, so a",
      "   *  larger interface font cannot skew the spacers. */",
      "  function paintCsvWindowMeasured(range) {",
      "    paintCsvWindow(range);",
      "    const measured = measureCsvRowHeight();",
      "    if (measured > 0 && Math.abs(measured - csvRowHeight) > 0.5) {",
      "      csvRowHeight = measured;",
      "      paintCsvWindow(csvWindowRange());",
      "    }",
      "  }",
      "",
      "  /** Bring a grid row into the window, scrolling to it when it is outside. */",
      "  function revealCsvRow(r) {",
      "    if (csvRowElements.has(r)) { return; }",
      "    const position = csvDisplayPositions.get(r);",
      "    if (position === undefined) { return; }",
      "    csvGridWrapEl.scrollTop = Math.max(0,",
      "      csvMultiline.layout.offset(position, csvRowHeight) - csvGridWrapEl.clientHeight / 2);",
      "    paintCsvWindowMeasured(csvWindowRange());",
      "  }",
      "",
      "  /** Removing a focused cell need not fire focusout, so an edit in progress",
      "   *  is committed here before the window is rebuilt. */",
      "  function flushCsvActiveEdit() {",
      "    csvFocusedCell = null;",
      "    const cell = document.activeElement;",
      "    if (!cell || !cell.classList || !cell.classList.contains('cell')) { return; }",
      "    const td = cell.closest('td');",
      "    if (!td || !tbodyEl.contains(td) || td.dataset.r == null) { return; }",
      "    const r = +td.dataset.r;",
      "    const c = +td.dataset.c;",
      "    csvFocusedCell = { r: r, c: c };",
      "    const value = readEditableCell(cell, grid[r] && grid[r][c]);",
      "    if (grid[r] && grid[r][c] !== value) {",
      "      const prev = snapshot();",
      "      grid[r][c] = value;",
      "      commitEdit('Edit cell ' + colName(c) + (r + 1), prev);",
      "    }",
      "  }",
      "",
      "  function restoreCsvFocusedCell() {",
      "    const focused = csvFocusedCell;",
      "    csvFocusedCell = null;",
      "    if (!focused) { return; }",
      "    const td = cellTd(focused.r, focused.c);",
      "    const cell = td ? td.querySelector('.cell') : null;",
      "    if (cell) { td.classList.add('editing'); cell.focus(); }",
      "  }",
      "",
      "  function updateCsvWindow() {",
      "    const range = csvWindowRange();",
      "    if (range.start === csvRenderedStart && range.end === csvRenderedEnd) { return; }",
      "    flushCsvActiveEdit();",
      "    paintCsvWindowMeasured(range);",
      "    reapplyMatches();",
      "    applySelection();",
      "    restoreCsvFocusedCell();",
      "  }",
      "",
      "  function scheduleCsvWindowUpdate() {",
      "    if (typeof requestAnimationFrame !== 'function') { updateCsvWindow(); return; }",
      "    if (csvWindowFrame) { return; }",
      "    csvWindowFrame = requestAnimationFrame(() => {",
      "      csvWindowFrame = 0;",
      "      updateCsvWindow();",
      "    });",
      "  }",
      "",
      "  csvGridWrapEl.addEventListener('scroll', scheduleCsvWindowUpdate, { passive: true });",
      "  window.addEventListener('resize', scheduleCsvWindowUpdate);",
      "",
      "  function render() {",
      "    const cols = grid[0] ? grid[0].length : 0;",
      "",
    ].join("\n"),
    "render entry point"
  );

  // ---- 3. render() builds one window instead of the whole file -------------
  decorated = replaceOnce(
    decorated,
    [
      "    // tbody: preamble (above header) keeps original order, then data by viewOrder.",
      "    let body = '';",
      "    for (let r = 0; r < headerRow; r++) {",
      "      body += rowHtml(r, cols, 'preamble-row');",
      "    }",
      "    // The header row is also shown in the table so it stays editable, marked apart.",
      "    body += rowHtml(headerRow, cols, 'header-row');",
      "    for (let k = 0; k < viewOrder.length; k++) {",
      "      body += rowHtml(viewOrder[k], cols, '');",
      "    }",
      "    tbodyEl.innerHTML = body;",
      "    // The tbody was replaced: rebuild the row index and drop the element",
      "    // references the previous highlights were holding.",
      "    rebuildCsvRowIndex();",
      "    csvHighlightedMatches = [];",
      "    csvHighlightedSelection = [];",
      "    csvCurrentMatchCell = null;",
      "",
    ].join("\n"),
    [
      "    // tbody: only the rows near the viewport, with two spacer rows standing",
      "    // in for the rest so the scrollbar still measures the whole file.",
      "    csvRenderedColumns = cols;",
      "    rebuildCsvDisplayOrder();",
      "    paintCsvWindowMeasured(csvWindowRange());",
      "    // render() rebuilt thead, so the pinned widths have to go back on.",
      "    lockCsvColumnWidths();",
      "",
    ].join("\n"),
    "tbody build"
  );

  // ---- 3b. A new file is measured afresh ----------------------------------
  decorated = replaceOnce(
    decorated,
    [
      "  function loadNewGrid() {",
      "    headerRow = guessHeaderRow(grid);",
      "    sortState = { col: -1, dir: null };",
      "    rebuildViewOrder();",
      "    render();",
      "  }",
    ].join("\n"),
    [
      "  function loadNewGrid() {",
      "    headerRow = guessHeaderRow(grid);",
      "    sortState = { col: -1, dir: null };",
      "    // Different content deserves its own column widths.",
      "    csvColumnWidths = null;",
      "    rebuildViewOrder();",
      "    render();",
      "  }",
    ].join("\n"),
    "new grid loader"
  );

  // ---- 4. Match highlighting proportional to the window --------------------
  decorated = replaceOnce(
    decorated,
    [
      "    // Mark all matching cells.",
      "    for (const m of matches) {",
      "      const td = cellTd(m.r, m.c);",
      "      if (td) { td.classList.add('match'); csvHighlightedMatches.push(td); }",
      "    }",
    ].join("\n"),
    [
      "    // Index the matches by row and paint only the rendered ones. A common",
      "    // word matches hundreds of thousands of cells, and touching each one",
      "    // costs far more than the scan that found them.",
      "    csvMatchColumns = new Map();",
      "    for (const m of matches) {",
      "      let columns = csvMatchColumns.get(m.r);",
      "      if (!columns) { columns = []; csvMatchColumns.set(m.r, columns); }",
      "      columns.push(m.c);",
      "    }",
      "    reapplyMatches();",
    ].join("\n"),
    "match marking loop"
  );

  decorated = replaceOnce(
    decorated,
    [
      "  /** Redraw highlights after render() rebuilds the tbody. */",
      "  function reapplyMatches() {",
      "    if (matches.length === 0) { return; }",
      "    for (let k = 0; k < matches.length; k++) {",
      "      const td = cellTd(matches[k].r, matches[k].c);",
      "      if (td) {",
      "        td.classList.add('match');",
      "        csvHighlightedMatches.push(td);",
      "        if (k === matchIndex) {",
      "          td.classList.add('match-current');",
      "          csvCurrentMatchCell = td;",
      "        }",
      "      }",
      "    }",
      "  }",
    ].join("\n"),
    [
      "  /** Redraw highlights after the rendered window changes. Walks the rows",
      "   *  that exist rather than every match, so it costs the window size. */",
      "  function reapplyMatches() {",
      "    if (matches.length === 0) { return; }",
      "    const current = matches[matchIndex];",
      "    for (const [r, tr] of csvRowElements) {",
      "      const columns = csvMatchColumns.get(r);",
      "      if (!columns) { continue; }",
      "      for (const c of columns) {",
      "        const td = tr.cells[c + 1];",
      "        if (!td) { continue; }",
      "        td.classList.add('match');",
      "        csvHighlightedMatches.push(td);",
      "        if (current && current.r === r && current.c === c) {",
      "          td.classList.add('match-current');",
      "          csvCurrentMatchCell = td;",
      "        }",
      "      }",
      "    }",
      "  }",
    ].join("\n"),
    "highlight reapplication"
  );

  // ---- 5. Match navigation reaches rows outside the window -----------------
  decorated = replaceOnce(
    decorated,
    [
      "    const m = matches[matchIndex];",
      "    if (!m) { return; }",
      "    const td = cellTd(m.r, m.c);",
      "    if (td) {",
      "      td.classList.add('match-current');",
      "      csvCurrentMatchCell = td;",
      "      td.scrollIntoView({ block: 'center', inline: 'center' });",
    ].join("\n"),
    [
      "    const m = matches[matchIndex];",
      "    if (!m) { return; }",
      "    // The match may be outside the rendered window; scrolling to it first",
      "    // puts the row in the DOM so it can be marked and revealed.",
      "    revealCsvRow(m.r);",
      "    const td = cellTd(m.r, m.c);",
      "    if (td) {",
      "      td.classList.add('match-current');",
      "      csvCurrentMatchCell = td;",
      "      td.scrollIntoView({ block: 'center', inline: 'center' });",
    ].join("\n"),
    "current-match focus"
  );

  decorated = replaceOnce(decorated,
    "    const newVal = cell.innerText.replace(/\\n$/, '');",
    "    const newVal = readEditableCell(cell, grid[r] && grid[r][c]);",
    "multiline edit reader"
  );
  return decorated;
}

module.exports = { ESTIMATED_ROW_HEIGHT, OVERSCAN_ROWS, decorateWebviewHtml };
