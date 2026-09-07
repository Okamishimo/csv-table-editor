"use strict";

/** Sparse height corrections for cells the reader explicitly expands. The
 * unloaded/collapsed rows remain uniform; no per-row allocation is needed for
 * a preview containing millions of records. This function also runs in the
 * webview, so keep it self-contained. */
function createRowLayout() {
  const extras = new Map();
  let positions = [];
  let sums = [0];
  let dirty = false;
  function offset(index, base) {
    if (dirty) {
      positions = Array.from(extras.keys()).sort((a, b) => a - b);
      sums = [0];
      for (const position of positions) sums.push(sums[sums.length - 1] + extras.get(position));
      dirty = false;
    }
    let low = 0, high = positions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (positions[middle] < index) low = middle + 1;
      else high = middle;
    }
    return index * base + sums[low];
  }
  return {
    offset,
    set(index, extra) {
      extra = Math.max(0, extra);
      if ((extras.get(index) || 0) === extra) return;
      if (extra) extras.set(index, extra);
      else extras.delete(index);
      dirty = true;
    },
    clear() { extras.clear(); dirty = true; },
    retain(first, end) {
      for (const index of extras.keys()) {
        if (index < first || index >= end) { extras.delete(index); dirty = true; }
      }
    },
    indexAt(y, total, base) {
      let low = 0, high = total;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (offset(middle + 1, base) <= y) low = middle + 1;
        else high = middle;
      }
      return Math.max(0, Math.min(total - 1, low));
    },
  };
}

const editableCss = `
  /* Reserve the same one-and-a-half-line slot for every collapsed row, so
     unseen rows have a known height. Only actual line breaks are shown. */
  #grid-wrap tbody tr:not(.csv-spacer) > td { vertical-align: top; padding: 3px 6px; }
  #grid-wrap td .cell { box-sizing: content-box; width: auto; padding: 0; height: 2.1em; line-height: 1.4; white-space: pre; overflow: hidden; }
  #grid-wrap td .cell.csv-expanded { height: auto; min-height: 2.1em; }
  #grid-wrap .csv-measuring td .cell.csv-expanded { height: 2.1em; min-height: 0; }
`;

const previewCss = `
  #rows td { height: var(--csv-preview-row-height, calc(2.1em + 7px)); line-height: 1.4; vertical-align: top; }
  .csv-multiline { height: 2.1em; white-space: pre; overflow: hidden; }
  .csv-multiline.csv-expanded { height: auto; min-height: 2.1em; }
  .csv-measuring .csv-multiline.csv-expanded { height: 2.1em; min-height: 0; }
`;

/** Runs inside the editable grid's existing nonce-bearing script. */
function installEditableMultiline() {
  const expanded = new Map();
  const layout = createRowLayout();

  function restore() {
    for (const [r, columns] of expanded) {
      const row = csvRowElements.get(r);
      if (!row) continue;
      for (const c of columns) {
        const cell = row.cells[c + 1]?.querySelector('.cell');
        if (cell) cell.classList.add('csv-expanded');
      }
    }
  }

  function measure() {
    for (const r of expanded.keys()) {
      const row = csvRowElements.get(r);
      if (!row) continue;
      const height = row.getBoundingClientRect().height;
      if (height > 0) layout.set(csvDisplayPositions.get(r), height - csvRowHeight);
    }
  }

  function resizeRow(row) {
    const r = +row.cells[1].dataset.r;
    const height = row.getBoundingClientRect().height;
    if (height > 0) layout.set(csvDisplayPositions.get(r), height - csvRowHeight);
    updateCsvSpacers();
  }

  tbodyEl.addEventListener('dblclick', (event) => {
    const td = event.target.closest('td[data-r][data-c]');
    const cell = td?.querySelector('.cell');
    if (!cell || (!cell.classList.contains('csv-expanded') && !/[\r\n]/.test(cell.innerText || cell.textContent))) return;
    event.preventDefault();
    const r = +td.dataset.r, c = +td.dataset.c;
    const open = cell.classList.toggle('csv-expanded');
    let columns = expanded.get(r);
    if (!columns) { columns = new Set(); expanded.set(r, columns); }
    if (open) columns.add(c);
    else columns.delete(c);
    // Reset the contenteditable's own scroll, too: the default view starts at
    // the first line even if the caret was on a later line while expanded.
    if (!open) { cell.scrollTop = 0; cell.scrollLeft = 0; }
    resizeRow(td.parentElement);
    if (!open) {
      const visibleTop = csvGridWrapEl.getBoundingClientRect().top + theadEl.getBoundingClientRect().height;
      const rect = td.parentElement.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom <= visibleTop) csvGridWrapEl.scrollTop += rect.top - visibleTop;
    }
    if (!columns.size) expanded.delete(r);
  });
  tbodyEl.addEventListener('input', (event) => {
    const cell = event.target.closest('.csv-expanded');
    if (cell) resizeRow(cell.closest('tr'));
  });

  return {
    layout, restore, measure,
    reset() { expanded.clear(); layout.clear(); },
  };
}

/** Plain text nodes contain the CSV's actual line breaks. Only the block
 * elements created by contenteditable need innerText's layout conversion. */
function readEditableCell(cell, original) {
  if (!cell.childElementCount) {
    const text = cell.textContent;
    // HTML parsing normalizes CRLF/CR, but merely opening a cell must not
    // rewrite its original value or strip a meaningful final line break.
    return typeof original === 'string' && text === original.replace(/\r\n?/g, '\n') ? original : text;
  }
  return (typeof cell.innerText === 'string' ? cell.innerText : cell.textContent).replace(/\n$/, '');
}

module.exports = { createRowLayout, editableCss, previewCss, installEditableMultiline, readEditableCell };
