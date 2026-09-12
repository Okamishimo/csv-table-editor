"use strict";

// Per-document UI lock. Saving existing edits and external reloads remain valid.
const readOnlyDocuments = new WeakSet();

function handleMessage(document, message) {
  if (message.type === "setReadOnly") {
    if (message.readOnly === true) readOnlyDocuments.add(document);
    else readOnlyDocuments.delete(document);
    return true;
  }
  if (message.type === "ready") readOnlyDocuments.delete(document);
  return readOnlyDocuments.has(document) &&
    ["edit", "pickEncoding"].includes(message.type);
}

function assertEditable(document) {
  if (readOnlyDocuments.has(document)) {
    throw new Error("This CSV is read-only. Switch to Editable to change it.");
  }
}

function canEdit(document, vscode) {
  if (!readOnlyDocuments.has(document)) return true;
  vscode.window.showInformationMessage("This CSV is read-only. Switch to Editable to change it.");
  return false;
}

function registerEdit(provider, document, label, undo, redo) {
  assertEditable(document);
  const apply = (op) => {
    // Reject before dispatch so VS Code does not silently advance its undo stack.
    assertEditable(document);
    const panel = provider._panels.get(document);
    if (panel) provider.post(panel, { type: "applyEdit", op });
  };
  provider._onDidChangeCustomDocument.fire({
    document, label, undo: () => apply(undo), redo: () => apply(redo),
  });
}

function replaceOnce(source, from, to) {
  const count = source.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`Cannot add edit mode switch: expected one ${from}, found ${count}.`);
  }
  return source.replace(from, to);
}

// Applied by edit-history after its delta patches, keeping the existing chain.
function decorateWebviewHtml(html) {
  if (html.includes('id="edit-mode"')) return html;
  let result = replaceOnce(html, '    <button id="add-row">',
    '    <button id="edit-mode" type="button" aria-label="Read-only mode" aria-pressed="false" title="Switch to read-only">Editable</button>\n    <button id="add-row">');
  result = replaceOnce(result, "  let grid = [[]];", `  let grid = [[]];
  let csvReadOnly = false;
  const csvEditModeButton = document.getElementById('edit-mode');

  function updateCsvEditModeControls() {
    document.body.classList.toggle('csv-read-only', csvReadOnly);
    csvEditModeButton.textContent = csvReadOnly ? 'Read-only' : 'Editable';
    csvEditModeButton.setAttribute('aria-pressed', String(csvReadOnly));
    csvEditModeButton.title = csvReadOnly ? 'Switch to editable' : 'Switch to read-only';
    document.getElementById('add-row').disabled = csvReadOnly;
    document.getElementById('add-col').disabled = csvReadOnly;
    encLabelEl.setAttribute('aria-disabled', String(csvReadOnly));
    // Only visit the rendered window. Future rows use the mode in rowHtml().
    for (const cell of tbodyEl.querySelectorAll('.cell')) {
      cell.setAttribute('contenteditable', String(!csvReadOnly));
      if (csvReadOnly) cell.closest('td').classList.remove('editing');
    }
  }

  csvEditModeButton.addEventListener('click', () => {
    // A programmatic/keyboard click may leave a cell focused. Preserve it before locking.
    if (!csvReadOnly) flushCsvActiveEdit();
    csvFocusedCell = null;
    csvReadOnly = !csvReadOnly;
    updateCsvEditModeControls();
    vscode.postMessage({ type: 'setReadOnly', readOnly: csvReadOnly });
  });

  // Native editing (including paste, cut and drop) is disabled by contenteditable.
  // Guard beforeinput too, without interfering with search or copying text.
  document.addEventListener('beforeinput', (event) => {
    if (csvReadOnly && event.target.closest('#grid-wrap .cell')) event.preventDefault();
  }, true);
  window.addEventListener('keydown', (event) => {
    if (csvReadOnly && (event.ctrlKey || event.metaKey) &&
        ['z', 'y'].includes(event.key.toLowerCase()) &&
        !event.target.closest('input, textarea')) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);`);
  result = replaceOnce(result, '</style>', `  .csv-read-only [data-delrow], .csv-read-only [data-delcol] { visibility: hidden; }
  .csv-read-only .cell { cursor: text; }
  .csv-read-only #enc-label, button:disabled { opacity: 0.6; }
  #edit-mode[aria-pressed="true"] { border-color: var(--vscode-focusBorder); }
</style>`);
  result = replaceOnce(result, 'contenteditable="true" spellcheck="false"',
    'contenteditable="\' + !csvReadOnly + \'" tabindex="0" spellcheck="false"');
  for (const anchor of [
    "  function flushCsvActiveEdit() {",
    "  tbodyEl.addEventListener('focusout', (e) => {",
    "  document.getElementById('add-row').addEventListener('click', () => {",
    "  document.getElementById('add-col').addEventListener('click', () => {",
    "  encLabelEl.addEventListener('click', () => {",
  ]) {
    result = replaceOnce(result, anchor, anchor + "\n    if (csvReadOnly) return;");
  }
  result = replaceOnce(result, "    if (delRow) {",
    "    if (csvReadOnly && (delRow || delCol)) return;\n    if (delRow) {");
  // Non-editable cells do not focus on click in every browser; retain cell selection.
  result = replaceOnce(result, "    const isDelBtn =",
    "    const readOnlyCell = csvReadOnly && e.target.closest('td[data-r][data-c]');\n" +
    "    if (readOnlyCell) { setSelection(+readOnlyCell.dataset.r, +readOnlyCell.dataset.c); return; }\n" +
    "    const isDelBtn =");
  result = replaceOnce(result, "      case 'rollback': {",
    "      case 'rollback': {\n        if (csvReadOnly) break;");
  return result;
}

module.exports = { decorateWebviewHtml, handleMessage, canEdit, registerEdit };
