"use strict";

/**
 * Performance decorator for the editable-grid webview.
 *
 * The shipped grid script addresses cells with attribute selectors
 * (`td[data-r=..][data-c=..]`) and clears highlights by querying the whole
 * table. Both cost O(cells) per call, and they run once per match, once per
 * selection change and once per render, so search, sorting and even a plain
 * cell click degrade to O(cells x matches) on anything but a tiny file.
 *
 * This module rewrites those paths to use a row index rebuilt once per render,
 * tracks the elements it highlights so clearing is proportional to the number
 * of highlights, debounces the filter input, and replaces the character-wise
 * CSV parser with a segment-copying one.
 *
 * It runs last in the decorator chain, so its anchors are the text produced by
 * `font-settings` and `search-scope`.
 */

const MARKER = "function csvRowIndexForGrid()";
const SEARCH_DEBOUNCE_MS = 120;

function replaceOnce(source, from, to, description) {
  const occurrences = source.split(from).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Cannot apply grid performance patch: expected one ${description}, found ${occurrences}.`
    );
  }
  return source.replace(from, to);
}

function decorateWebviewHtml(html) {
  if (html.includes(MARKER)) return html;

  let decorated = html;

  // ---- 1. Segment-copying CSV parser -------------------------------------
  // The original appends one character at a time. This copies whole runs
  // between structural characters in single slices: same output, ~4x faster.
  decorated = replaceOnce(
    decorated,
    [
      "    while (i < n) {",
      "      const c = text[i];",
      "      if (inQuotes) {",
      "        if (c === '\"') {",
      "          if (text[i + 1] === '\"') { field += '\"'; i += 2; continue; }",
      "          inQuotes = false; i++; continue;",
      "        }",
      "        field += c; i++; continue;",
      "      }",
      "      if (c === '\"') { inQuotes = true; i++; continue; }",
      "      if (c === ',') { row.push(field); field = ''; i++; continue; }",
      "      if (c === '\\r') {",
      "        if (text[i + 1] === '\\n') { i++; }",
      "        row.push(field); field = ''; rows.push(row); row = []; i++; continue;",
      "      }",
      "      if (c === '\\n') {",
      "        row.push(field); field = ''; rows.push(row); row = []; i++; continue;",
      "      }",
      "      field += c; i++;",
      "    }",
    ].join("\n"),
    [
      "    // Character codes of the only characters that end a run: \" , CR LF.",
      "    while (i < n) {",
      "      if (inQuotes) {",
      "        const quote = text.indexOf('\"', i);",
      "        if (quote < 0) { field += text.slice(i); i = n; break; }",
      "        field += text.slice(i, quote);",
      "        if (text.charCodeAt(quote + 1) === 34) { field += '\"'; i = quote + 2; continue; }",
      "        inQuotes = false; i = quote + 1; continue;",
      "      }",
      "      // Copy the whole run up to the next structural character at once.",
      "      let j = i;",
      "      while (j < n) {",
      "        const code = text.charCodeAt(j);",
      "        if (code === 34 || code === 44 || code === 13 || code === 10) { break; }",
      "        j++;",
      "      }",
      "      if (j > i) { field += text.slice(i, j); i = j; if (i >= n) { break; } }",
      "      const code = text.charCodeAt(i);",
      "      if (code === 34) { inQuotes = true; i++; continue; }",
      "      if (code === 44) { row.push(field); field = ''; i++; continue; }",
      "      if (code === 13) {",
      "        if (text.charCodeAt(i + 1) === 10) { i++; }",
      "        row.push(field); field = ''; rows.push(row); row = []; i++; continue;",
      "      }",
      "      row.push(field); field = ''; rows.push(row); row = []; i++;",
      "    }",
    ].join("\n"),
    "CSV parse loop"
  );

  // ---- 2. Row index rebuilt once per render ------------------------------
  decorated = replaceOnce(
    decorated,
    "    tbodyEl.innerHTML = body;\n",
    [
      "    tbodyEl.innerHTML = body;",
      "    // The tbody was replaced: rebuild the row index and drop the element",
      "    // references the previous highlights were holding.",
      "    rebuildCsvRowIndex();",
      "    csvHighlightedMatches = [];",
      "    csvHighlightedSelection = [];",
      "    csvCurrentMatchCell = null;",
      "",
    ].join("\n"),
    "tbody assignment"
  );

  // ---- 3. O(1) cell lookup ------------------------------------------------
  decorated = replaceOnce(
    decorated,
    [
      "  function cellTd(r, c) {",
      "    return tbodyEl.querySelector('td[data-r=\"' + r + '\"][data-c=\"' + c + '\"]');",
      "  }",
    ].join("\n"),
    [
      "  /** Original grid row index -> its <tr>. Rebuilt once per render so cell",
      "   *  lookups cost O(1) instead of an attribute query over the whole table. */",
      "  let csvRowElements = new Map();",
      "",
      "  function csvRowIndexForGrid() { return csvRowElements; }",
      "",
      "  function rebuildCsvRowIndex() {",
      "    csvRowElements = new Map();",
      "    const rows = tbodyEl.rows;",
      "    for (let i = 0; i < rows.length; i++) {",
      "      const head = rows[i].cells[0];",
      "      const index = head ? head.dataset.rowhead : null;",
      "      if (index != null) { csvRowElements.set(+index, rows[i]); }",
      "    }",
      "  }",
      "",
      "  function rowTr(r) {",
      "    return csvRowElements.get(r) || null;",
      "  }",
      "",
      "  function cellTd(r, c) {",
      "    const tr = csvRowElements.get(r);",
      "    // cells[0] is the row-number header, so data column c sits at c + 1.",
      "    return tr ? tr.cells[c + 1] || null : null;",
      "  }",
    ].join("\n"),
    "cell lookup helper"
  );

  // ---- 4. Selection highlight without whole-table queries -----------------
  decorated = replaceOnce(
    decorated,
    [
      "  function applySelection() {",
      "    // Clear any previous selection highlight.",
      "    tbodyEl.querySelectorAll('.sel-row, .sel-col, .sel-active, .sel-head')",
      "      .forEach((el) => el.classList.remove('sel-row', 'sel-col', 'sel-active', 'sel-head'));",
      "    theadEl.querySelectorAll('.sel-head')",
      "      .forEach((el) => el.classList.remove('sel-head'));",
      "    if (sel.r < 0 && sel.c < 0) { return; }",
      "",
      "    // Whole column: every cell with data-c === sel.c + that column's header.",
      "    if (sel.c >= 0) {",
      "      tbodyEl.querySelectorAll('td[data-c=\"' + sel.c + '\"]')",
      "        .forEach((td) => td.classList.add('sel-col'));",
      "      const colHead = theadEl.querySelector('th[data-colhead=\"' + sel.c + '\"]');",
      "      if (colHead) { colHead.classList.add('sel-head'); }",
      "    }",
      "    // Whole row: every cell with data-r === sel.r + that row's number cell.",
      "    if (sel.r >= 0) {",
      "      tbodyEl.querySelectorAll('td[data-r=\"' + sel.r + '\"]')",
      "        .forEach((td) => td.classList.add('sel-row'));",
      "      const rowHead = tbodyEl.querySelector('th[data-rowhead=\"' + sel.r + '\"]');",
      "      if (rowHead) { rowHead.classList.add('sel-head'); }",
      "    }",
      "    // Intersection cell.",
      "    if (sel.r >= 0 && sel.c >= 0) {",
      "      const active = tbodyEl.querySelector(",
      "        'td[data-r=\"' + sel.r + '\"][data-c=\"' + sel.c + '\"]');",
      "      if (active) { active.classList.add('sel-active'); }",
      "    }",
      "  }",
    ].join("\n"),
    [
      "  /** Selecting a row or column used to add a class to every cell in it.",
      "   *  Painting it with a handful of stylesheet rules instead makes the",
      "   *  selection O(1) DOM work, whatever the table size. */",
      "  const SEL_SOFT = 'background: var(--vscode-list-inactiveSelectionBackground);';",
      "  const SEL_STRONG = 'background: var(--vscode-list-activeSelectionBackground);' +",
      "    ' color: var(--vscode-list-activeSelectionForeground);';",
      "",
      "  /** The page's own nonce-approved stylesheet, or null when rules cannot be",
      "   *  edited; a new <style> element would be refused by the webview CSP. */",
      "  const csvSelectionSheet = (() => {",
      "    try {",
      "      const sheets = document.styleSheets;",
      "      for (let i = 0; i < sheets.length; i++) {",
      "        const sheet = sheets[i];",
      "        const owner = sheet && sheet.ownerNode;",
      "        // Only this page's <style>; never one the host injected alongside it.",
      "        if (!owner || owner.tagName !== 'STYLE') { continue; }",
      "        if (owner.textContent.indexOf('.sort-header') < 0) { continue; }",
      "        if (typeof sheet.insertRule !== 'function') { return null; }",
      "        // Probe once, so an unusable sheet shows up here, not mid-selection.",
      "        sheet.deleteRule(sheet.insertRule('.csv-probe { color: inherit; }', sheet.cssRules.length));",
      "        return sheet;",
      "      }",
      "      return null;",
      "    } catch (error) {",
      "      return null;",
      "    }",
      "  })();",
      "  let csvSelectionRuleCount = 0;",
      "",
      "  /** Rules mirroring the .sel-* declarations in the static stylesheet. */",
      "  function csvSelectionRules() {",
      "    const rules = [];",
      "    if (sel.c >= 0) {",
      "      rules.push('tbody td[data-c=\"' + sel.c + '\"] .cell {' + SEL_SOFT + '}');",
      "      rules.push('thead th[data-colhead=\"' + sel.c + '\"] {' + SEL_STRONG + '}');",
      "    }",
      "    if (sel.r >= 0) {",
      "      rules.push('tbody td[data-r=\"' + sel.r + '\"] .cell {' + SEL_SOFT + '}');",
      "      rules.push('tbody th.row-actions[data-rowhead=\"' + sel.r + '\"] {' + SEL_STRONG + '}');",
      "    }",
      "    // The intersection cell is pushed last so it outranks the row and column.",
      "    if (sel.r >= 0 && sel.c >= 0) {",
      "      const cell = 'tbody td[data-r=\"' + sel.r + '\"][data-c=\"' + sel.c + '\"]';",
      "      rules.push(cell + ' .cell {' + SEL_STRONG + '}');",
      "      rules.push(cell + ' { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }');",
      "    }",
      "    return rules;",
      "  }",
      "",
      "  /** Elements carrying a selection class, used only by the fallback path. */",
      "  let csvHighlightedSelection = [];",
      "",
      "  function applySelection() {",
      "    if (!csvSelectionSheet) { applySelectionByClass(); return; }",
      "    // Our rules are always the last ones in the sheet; nothing else adds any.",
      "    while (csvSelectionRuleCount > 0) {",
      "      csvSelectionSheet.deleteRule(csvSelectionSheet.cssRules.length - 1);",
      "      csvSelectionRuleCount--;",
      "    }",
      "    if (sel.r < 0 && sel.c < 0) { return; }",
      "    for (const rule of csvSelectionRules()) {",
      "      csvSelectionSheet.insertRule(rule, csvSelectionSheet.cssRules.length);",
      "      csvSelectionRuleCount++;",
      "    }",
      "  }",
      "",
      "  /** Original behaviour, kept for hosts whose stylesheet cannot be edited. */",
      "  function applySelectionByClass() {",
      "    for (const el of csvHighlightedSelection) {",
      "      el.classList.remove('sel-row', 'sel-col', 'sel-active', 'sel-head');",
      "    }",
      "    csvHighlightedSelection = [];",
      "    if (sel.r < 0 && sel.c < 0) { return; }",
      "",
      "    const mark = (el, cls) => {",
      "      if (!el) { return; }",
      "      el.classList.add(cls);",
      "      csvHighlightedSelection.push(el);",
      "    };",
      "",
      "    // Whole column: one cell per rendered row, reached by index.",
      "    if (sel.c >= 0) {",
      "      const rows = tbodyEl.rows;",
      "      for (let i = 0; i < rows.length; i++) { mark(rows[i].cells[sel.c + 1], 'sel-col'); }",
      "      mark(theadEl.querySelector('th[data-colhead=\"' + sel.c + '\"]'), 'sel-head');",
      "    }",
      "    // Whole row: the cells of a single <tr>, plus its row-number cell.",
      "    const selectedRow = sel.r >= 0 ? rowTr(sel.r) : null;",
      "    if (selectedRow) {",
      "      const cells = selectedRow.cells;",
      "      for (let i = 1; i < cells.length; i++) { mark(cells[i], 'sel-row'); }",
      "      mark(cells[0], 'sel-head');",
      "    }",
      "    // Intersection cell.",
      "    if (sel.r >= 0 && sel.c >= 0) { mark(cellTd(sel.r, sel.c), 'sel-active'); }",
      "  }",
    ].join("\n"),
    "selection highlighter"
  );

  // ---- 5. Rescan only when the search scope actually changes --------------
  decorated = replaceOnce(
    decorated,
    [
      "  function setSelection(r, c) {",
      "    const isSameWholeColumn = r < 0 && c >= 0 && sel.r < 0 && sel.c === c;",
      "    sel = isSameWholeColumn ? { r: -1, c: -1 } : { r: r, c: c };",
      "    applySelection();",
      "    updateCsvSearchScope();",
      "    runSearch(false);",
      "  }",
    ].join("\n"),
    [
      "  function setSelection(r, c) {",
      "    const isSameWholeColumn = r < 0 && c >= 0 && sel.r < 0 && sel.c === c;",
      "    const scopeBefore = csvHasColumnSearchScope() ? sel.c : -1;",
      "    sel = isSameWholeColumn ? { r: -1, c: -1 } : { r: r, c: c };",
      "    applySelection();",
      "    const scopeAfter = csvHasColumnSearchScope() ? sel.c : -1;",
      "    // Only a change of column scope can change the result set, so an ordinary",
      "    // cell click no longer rescans the whole grid.",
      "    if (scopeBefore !== scopeAfter) {",
      "      updateCsvSearchScope();",
      "      runSearch(false);",
      "    }",
      "  }",
    ].join("\n"),
    "selection function"
  );

  // ---- 6. Cheaper HTML escaping ------------------------------------------
  decorated = replaceOnce(
    decorated,
    [
      "  function escapeHtml(s) {",
      "    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');",
      "  }",
    ].join("\n"),
    [
      "  const CSV_HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };",
      "",
      "  function escapeHtml(s) {",
      "    // Most cells hold nothing to escape, so one test beats three passes.",
      "    return /[&<>]/.test(s) ? s.replace(/[&<>]/g, (ch) => CSV_HTML_ESCAPES[ch]) : s;",
      "  }",
    ].join("\n"),
    "HTML escaper"
  );

  // ---- 7. Match highlights tracked instead of queried ---------------------
  decorated = replaceOnce(
    decorated,
    [
      "  function clearHighlights() {",
      "    tbodyEl.querySelectorAll('td.match, td.match-current')",
      "      .forEach((td) => td.classList.remove('match', 'match-current'));",
      "  }",
    ].join("\n"),
    [
      "  /** Cells currently carrying a match class, and the current one. */",
      "  let csvHighlightedMatches = [];",
      "  let csvCurrentMatchCell = null;",
      "",
      "  function clearHighlights() {",
      "    for (const td of csvHighlightedMatches) {",
      "      td.classList.remove('match', 'match-current');",
      "    }",
      "    csvHighlightedMatches = [];",
      "    csvCurrentMatchCell = null;",
      "  }",
    ].join("\n"),
    "highlight clearer"
  );

  decorated = replaceOnce(
    decorated,
    [
      "    // Mark all matching cells.",
      "    for (const m of matches) {",
      "      const td = cellTd(m.r, m.c);",
      "      if (td) { td.classList.add('match'); }",
      "    }",
    ].join("\n"),
    [
      "    // Mark all matching cells.",
      "    for (const m of matches) {",
      "      const td = cellTd(m.r, m.c);",
      "      if (td) { td.classList.add('match'); csvHighlightedMatches.push(td); }",
      "    }",
    ].join("\n"),
    "match marking loop"
  );

  decorated = replaceOnce(
    decorated,
    [
      "      const td = cellTd(matches[k].r, matches[k].c);",
      "      if (td) {",
      "        td.classList.add('match');",
      "        if (k === matchIndex) { td.classList.add('match-current'); }",
      "      }",
    ].join("\n"),
    [
      "      const td = cellTd(matches[k].r, matches[k].c);",
      "      if (td) {",
      "        td.classList.add('match');",
      "        csvHighlightedMatches.push(td);",
      "        if (k === matchIndex) {",
      "          td.classList.add('match-current');",
      "          csvCurrentMatchCell = td;",
      "        }",
      "      }",
    ].join("\n"),
    "match reapply loop"
  );

  decorated = replaceOnce(
    decorated,
    [
      "  function focusMatch() {",
      "    tbodyEl.querySelectorAll('td.match-current')",
      "      .forEach((td) => td.classList.remove('match-current'));",
      "    const m = matches[matchIndex];",
      "    if (!m) { return; }",
      "    const td = cellTd(m.r, m.c);",
      "    if (td) {",
      "      td.classList.add('match-current');",
    ].join("\n"),
    [
      "  function focusMatch() {",
      "    if (csvCurrentMatchCell) { csvCurrentMatchCell.classList.remove('match-current'); }",
      "    csvCurrentMatchCell = null;",
      "    const m = matches[matchIndex];",
      "    if (!m) { return; }",
      "    const td = cellTd(m.r, m.c);",
      "    if (td) {",
      "      td.classList.add('match-current');",
      "      csvCurrentMatchCell = td;",
    ].join("\n"),
    "current-match focus"
  );

  // ---- 8. Debounced filter input -----------------------------------------
  decorated = replaceOnce(
    decorated,
    [
      "  filterEl.addEventListener('input', () => runSearch(false));",
      "  filterEl.addEventListener('keydown', (e) => {",
      "    if (e.key === 'Enter') {",
      "      e.preventDefault();",
      "      stepMatch(e.shiftKey ? -1 : 1);",
      "    } else if (e.key === 'Escape') {",
      "      filterEl.value = '';",
      "      runSearch(false);",
      "      filterEl.blur();",
      "    }",
      "  });",
    ].join("\n"),
    [
      "  /** One grid scan per typing pause instead of one per keystroke. */",
      "  let csvSearchTimer = 0;",
      "",
      "  function cancelCsvSearch() {",
      "    if (!csvSearchTimer) { return false; }",
      "    clearTimeout(csvSearchTimer);",
      "    csvSearchTimer = 0;",
      "    return true;",
      "  }",
      "",
      "  filterEl.addEventListener('input', () => {",
      "    cancelCsvSearch();",
      `    csvSearchTimer = setTimeout(() => {`,
      "      csvSearchTimer = 0;",
      "      runSearch(false);",
      `    }, ${SEARCH_DEBOUNCE_MS});`,
      "  });",
      "  filterEl.addEventListener('keydown', (e) => {",
      "    if (e.key === 'Enter') {",
      "      e.preventDefault();",
      "      // Enter must act on what was typed, so run any pending search first.",
      "      if (cancelCsvSearch()) { runSearch(false); }",
      "      stepMatch(e.shiftKey ? -1 : 1);",
      "    } else if (e.key === 'Escape') {",
      "      cancelCsvSearch();",
      "      filterEl.value = '';",
      "      runSearch(false);",
      "      filterEl.blur();",
      "    }",
      "  });",
    ].join("\n"),
    "search input handlers"
  );

  return decorated;
}

module.exports = { SEARCH_DEBOUNCE_MS, decorateWebviewHtml };
