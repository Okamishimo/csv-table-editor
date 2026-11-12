"use strict";

/** Runs in both webviews. A fixed table layout needs an explicit table width:
 * max-content/auto would still let newly rendered text change the geometry.
 * Keep widths independent of CSV values, including when there is no layout
 * to measure yet. The colgroup also works when the first body row is a spacer.
 */
function applyFixedColumnLayout(table, columns, rowCount = 1) {
  const dataWidth = 200;
  // Reserve the file's largest row number, plus room for the editable grid's
  // delete button and padding. Font-relative units follow font changes without
  // measuring cells or letting a page change the width while scrolling.
  const digits = String(Math.max(1, rowCount)).length;
  const numberWidth = 'max(44px, calc(' + digits + 'ch + 1.5em + 14px))';
  if (table.style.getPropertyValue('--csv-row-number-width') !== numberWidth) {
    table.style.setProperty('--csv-row-number-width', numberWidth);
  }
  let group = table.querySelector('colgroup');
  if (!group) {
    group = table.ownerDocument.createElement('colgroup');
    table.prepend(group);
  }
  if (group.children.length === columns + 1) return;
  const fragment = table.ownerDocument.createDocumentFragment();
  for (let index = 0; index <= columns; index++) {
    const column = table.ownerDocument.createElement('col');
    column.style.width = index === 0 ? 'var(--csv-row-number-width)' : dataWidth + 'px';
    fragment.appendChild(column);
  }
  group.replaceChildren(fragment);
  table.style.tableLayout = 'fixed';
  // One extra pixel accounts for the collapsed outer border.
  table.style.width = 'calc(' + (columns * dataWidth + 1) + 'px + var(--csv-row-number-width))';
}

module.exports = { applyFixedColumnLayout };
