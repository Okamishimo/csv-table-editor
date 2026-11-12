"use strict";

/** Runs in both webviews. A fixed table layout needs an explicit table width:
 * max-content/auto would still let newly rendered text change the geometry.
 * Keep widths independent of CSV values, including when there is no layout
 * to measure yet. The colgroup also works when the first body row is a spacer.
 */
function applyFixedColumnLayout(table, columns) {
  const dataWidth = 200;
  const numberWidth = 80;
  let group = table.querySelector('colgroup');
  if (!group) {
    group = table.ownerDocument.createElement('colgroup');
    table.prepend(group);
  }
  if (group.children.length === columns + 1) return;
  const fragment = table.ownerDocument.createDocumentFragment();
  for (let index = 0; index <= columns; index++) {
    const column = table.ownerDocument.createElement('col');
    column.style.width = (index === 0 ? numberWidth : dataWidth) + 'px';
    fragment.appendChild(column);
  }
  group.replaceChildren(fragment);
  table.style.tableLayout = 'fixed';
  // One extra pixel accounts for the collapsed outer border.
  table.style.width = (numberWidth + columns * dataWidth + 1) + 'px';
}

module.exports = { applyFixedColumnLayout };
