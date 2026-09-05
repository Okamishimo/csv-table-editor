"use strict";

/**
 * Delta-based undo/redo for the editable-grid webview.
 *
 * Every change used to send two complete copies of the grid to the extension
 * host: the state before and the state after. Both copies were then retained
 * for the lifetime of the undo stack, because VS Code holds the undo and redo
 * closures of every edit it is given. Typing in one cell of a 14 MiB CSV cost
 * about 190 ms of copying and structured cloning, and permanently retained
 * 3.2 million strings; a few dozen edits were enough to exhaust the host.
 *
 * This module replaces the payload with a description of the change itself.
 * Editing a cell now carries two values instead of two grids, and deleting a
 * row carries that row. Only a history rollback, which really does replace
 * everything, still travels as a whole grid, and it happens once per rollback
 * rather than once per keystroke.
 *
 * It runs last in the decorator chain because it rewrites the commit made by
 * `grid-virtualization.js` as well as the ones in the original grid script.
 *
 * The operation shape is:
 *
 *   { k: 'cell',   r, c, v }        set one cell
 *   { k: 'rowIn',  at, row }        insert a row
 *   { k: 'rowOut', at }             remove a row
 *   { k: 'colIn',  at, values? }    insert a column, blank when values is absent
 *   { k: 'colOut', at }             remove a column
 *   { k: 'full',   grid }           replace everything (rollback only)
 *
 * `headerRow` and `sortCol`/`sortDir` ride along only on the operations that
 * change them, so undoing a cell edit does not disturb a sort the reader
 * applied afterwards.
 */

const MARKER = "function applyCsvEdit(op)";

function replaceOnce(source, from, to, description) {
  const occurrences = source.split(from).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Cannot apply edit history patch: expected one ${description}, found ${occurrences}.`
    );
  }
  return source.replace(from, to);
}

function decorateWebviewHtml(html) {
  if (html.includes(MARKER)) return html;

  let decorated = html;

  // ---- 1. The operation vocabulary ----------------------------------------
  decorated = replaceOnce(
    decorated,
    [
      "  function commitEdit(label, prev) {",
      "    vscode.postMessage({",
      "      type: 'edit', label: label, snapshot: snapshot(), prevSnapshot: prev",
      "    });",
      "  }",
    ].join("\n"),
    [
      "  /** Tag an operation with the header position it must restore. */",
      "  function csvWithHeader(op) {",
      "    op.headerRow = headerRow;",
      "    return op;",
      "  }",
      "",
      "  /** Tag an operation with the sort state it must restore. */",
      "  function csvWithSort(op) {",
      "    op.sortCol = sortState.col;",
      "    op.sortDir = sortState.dir;",
      "    return op;",
      "  }",
      "",
      "  /** Record one reversible change as the change itself, not as two copies",
      "   *  of the whole grid; the host retains these for the session. */",
      "  function commitEdit(label, undo, redo) {",
      "    vscode.postMessage({ type: 'edit', label: label, undo: undo, redo: redo });",
      "  }",
      "",
      "  function applyCsvEdit(op) {",
      "    if (op.k === 'cell') {",
      "      if (grid[op.r]) { grid[op.r][op.c] = op.v; }",
      "    } else if (op.k === 'rowIn') {",
      "      grid.splice(op.at, 0, op.row.slice());",
      "    } else if (op.k === 'rowOut') {",
      "      grid.splice(op.at, 1);",
      "    } else if (op.k === 'colIn') {",
      "      for (let r = 0; r < grid.length; r++) {",
      "        grid[r].splice(op.at, 0, op.values && op.values[r] != null ? op.values[r] : '');",
      "      }",
      "    } else if (op.k === 'colOut') {",
      "      for (let r = 0; r < grid.length; r++) { grid[r].splice(op.at, 1); }",
      "    } else if (op.k === 'full') {",
      "      grid = op.grid.map((row) => row.slice());",
      "    }",
      "    if (op.sortCol !== undefined) { sortState = { col: op.sortCol, dir: op.sortDir }; }",
      "    // The structure may have changed, so keep the header in bounds whether",
      "    // or not this operation carries one.",
      "    const target = op.headerRow !== undefined ? op.headerRow : headerRow;",
      "    headerRow = Math.max(0, Math.min(target, grid.length - 1));",
      "    rebuildViewOrder();",
      "    render();",
      "  }",
    ].join("\n"),
    "edit commit helper"
  );

  // ---- 2. Cell edits carry two values ------------------------------------
  decorated = replaceOnce(
    decorated,
    [
      "    if (grid[r][c] !== newVal) {",
      "      const prev = snapshot();",
      "      grid[r][c] = newVal;",
      "      commitEdit('Edit cell ' + colName(c) + (r + 1), prev);",
      "    }",
    ].join("\n"),
    [
      "    if (grid[r][c] !== newVal) {",
      "      const previous = grid[r][c];",
      "      grid[r][c] = newVal;",
      "      commitEdit('Edit cell ' + colName(c) + (r + 1),",
      "        { k: 'cell', r: r, c: c, v: previous },",
      "        { k: 'cell', r: r, c: c, v: newVal });",
      "    }",
    ].join("\n"),
    "cell edit commit"
  );

  // The same commit made when scrolling evicts a cell that is being edited.
  decorated = replaceOnce(
    decorated,
    [
      "    if (grid[r] && grid[r][c] !== value) {",
      "      const prev = snapshot();",
      "      grid[r][c] = value;",
      "      commitEdit('Edit cell ' + colName(c) + (r + 1), prev);",
      "    }",
    ].join("\n"),
    [
      "    if (grid[r] && grid[r][c] !== value) {",
      "      const previous = grid[r][c];",
      "      grid[r][c] = value;",
      "      commitEdit('Edit cell ' + colName(c) + (r + 1),",
      "        { k: 'cell', r: r, c: c, v: previous },",
      "        { k: 'cell', r: r, c: c, v: value });",
      "    }",
    ].join("\n"),
    "evicted cell edit commit"
  );

  // ---- 3. Deleting a row carries that row --------------------------------
  decorated = replaceOnce(
    decorated,
    [
      "      const prev = snapshot();",
      "      grid.splice(r, 1);",
      "      // Deleting a row at/above the header shifts the header up; never negative.",
      "      if (r < headerRow) { headerRow--; }",
      "      else if (r === headerRow) { headerRow = Math.min(headerRow, grid.length - 1); }",
      "      rebuildViewOrder();",
      "      render();",
      "      commitEdit('Delete row ' + (r + 1), prev);",
    ].join("\n"),
    [
      "      const restoreRow = csvWithHeader({ k: 'rowIn', at: r, row: grid[r].slice() });",
      "      grid.splice(r, 1);",
      "      // Deleting a row at/above the header shifts the header up; never negative.",
      "      if (r < headerRow) { headerRow--; }",
      "      else if (r === headerRow) { headerRow = Math.min(headerRow, grid.length - 1); }",
      "      rebuildViewOrder();",
      "      render();",
      "      commitEdit('Delete row ' + (r + 1), restoreRow,",
      "        csvWithHeader({ k: 'rowOut', at: r }));",
    ].join("\n"),
    "row deletion commit"
  );

  // ---- 4. Deleting a column carries that column --------------------------
  decorated = replaceOnce(
    decorated,
    [
      "      const prev = snapshot();",
      "      for (const row of grid) { row.splice(c, 1); }",
      "      // A deleted column makes the current sort meaningless if it matches.",
      "      if (sortState.col === c) { sortState = { col: -1, dir: null }; }",
      "      else if (sortState.col > c) { sortState.col--; }",
      "      rebuildViewOrder();",
      "      render();",
      "      commitEdit('Delete column ' + colName(c), prev);",
    ].join("\n"),
    [
      "      // One value per row, not one row per row: the column, not the grid.",
      "      const restoreColumn = csvWithSort({",
      "        k: 'colIn', at: c, values: grid.map((row) => row[c]),",
      "      });",
      "      for (const row of grid) { row.splice(c, 1); }",
      "      // A deleted column makes the current sort meaningless if it matches.",
      "      if (sortState.col === c) { sortState = { col: -1, dir: null }; }",
      "      else if (sortState.col > c) { sortState.col--; }",
      "      rebuildViewOrder();",
      "      render();",
      "      commitEdit('Delete column ' + colName(c), restoreColumn,",
      "        csvWithSort({ k: 'colOut', at: c }));",
    ].join("\n"),
    "column deletion commit"
  );

  // ---- 5. Additions describe themselves ----------------------------------
  decorated = replaceOnce(
    decorated,
    [
      "    const prev = snapshot();",
      "    const cols = grid[0] ? grid[0].length : 1;",
      "    grid.push(new Array(cols).fill(''));",
      "    rebuildViewOrder();",
      "    render();",
      "    commitEdit('Add row', prev);",
    ].join("\n"),
    [
      "    const cols = grid[0] ? grid[0].length : 1;",
      "    const at = grid.length;",
      "    grid.push(new Array(cols).fill(''));",
      "    rebuildViewOrder();",
      "    render();",
      "    commitEdit('Add row', csvWithHeader({ k: 'rowOut', at: at }),",
      "      csvWithHeader({ k: 'rowIn', at: at, row: new Array(cols).fill('') }));",
    ].join("\n"),
    "row addition commit"
  );

  decorated = replaceOnce(
    decorated,
    [
      "    const prev = snapshot();",
      "    for (const row of grid) { row.push(''); }",
      "    render();",
      "    commitEdit('Add column', prev);",
    ].join("\n"),
    [
      "    const at = grid[0] ? grid[0].length : 0;",
      "    for (const row of grid) { row.push(''); }",
      "    render();",
      "    // colIn without values inserts blanks, so the redo carries no data.",
      "    commitEdit('Add column', csvWithSort({ k: 'colOut', at: at }),",
      "      csvWithSort({ k: 'colIn', at: at }));",
    ].join("\n"),
    "column addition commit"
  );

  // ---- 6. A rollback really does replace everything ----------------------
  decorated = replaceOnce(
    decorated,
    [
      "        const prev = snapshot();",
      "        grid = parseCsv(msg.text);",
      "        encLabelEl.textContent = '· ' + msg.encodingLabel;",
      "        loadNewGrid();",
      "        commitEdit('Roll back to history version', prev);",
    ].join("\n"),
    [
      "        // The whole grid is the change here, so it is the payload. This",
      "        // happens once per rollback, not once per keystroke.",
      "        const before = csvWithSort(csvWithHeader({ k: 'full', grid: snapshot() }));",
      "        grid = parseCsv(msg.text);",
      "        encLabelEl.textContent = '· ' + msg.encodingLabel;",
      "        loadNewGrid();",
      "        commitEdit('Roll back to history version', before,",
      "          csvWithSort(csvWithHeader({ k: 'full', grid: snapshot() })));",
    ].join("\n"),
    "rollback commit"
  );

  // ---- 7. Undo and redo apply an operation -------------------------------
  decorated = replaceOnce(
    decorated,
    [
      "      case 'applySnapshot':",
      "        grid = msg.grid.map((r) => r.slice());",
      "        // After undo/redo the structure may change; keep headerRow in bounds and rebuild.",
      "        headerRow = Math.max(0, Math.min(headerRow, grid.length - 1));",
      "        rebuildViewOrder();",
      "        render();",
      "        break;",
    ].join("\n"),
    [
      "      case 'applyEdit':",
      "        applyCsvEdit(msg.op);",
      "        break;",
    ].join("\n"),
    "undo/redo handler"
  );

  return decorated;
}

module.exports = { decorateWebviewHtml };
