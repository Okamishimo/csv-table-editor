"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  HARD_MAX_FILE_SIZE_MB,
  clampLimit,
  formatBytes,
} = require("./large-file-guard");
const {
  getFontFamily,
  watchFontFamily,
} = require("./font-settings");

const MIB = 1024 * 1024;
const SAMPLE_BYTES = 256 * 1024;
const PAGE_ROWS = 100;
const STREAM_CHUNK_BYTES = 64 * 1024;
const STREAM_YIELD_BYTES = 256 * 1024;
const MAX_PREVIEW_COLUMNS = 100;
const MAX_PREVIEW_CELL_CHARS = 4_096;
const MAX_PREVIEW_ROW_CHARS = 32_768;
const EDITABLE_OVERRIDES = new Set();

async function createLargeDocumentIfNeeded(uri, openContext, vscode, encodingApi) {
  if (!uri || uri.scheme === "untitled") return null;

  const uriKey = uri.toString();
  if (EDITABLE_OVERRIDES.delete(uriKey)) {
    openContext.__csvTableEditorAllowLargeFile = true;
    return null;
  }

  const stat = await vscode.workspace.fs.stat(uri);
  const configuredLimit = Number(
    vscode.workspace.getConfiguration("csvTableEditor").get("maxFileSizeMB", 64)
  );
  const maximumBytes = clampLimit(configuredLimit) * MIB;
  if (stat.size <= maximumBytes) {
    openContext.__csvTableEditorAllowLargeFile = true;
    return null;
  }

  if (uri.scheme !== "file" || !uri.fsPath) {
    const message =
      `CSV Table Editor cannot stream ${formatBytes(stat.size)} from the ${uri.scheme} file system. ` +
      "Open it as text instead.";
    const action = await vscode.window.showWarningMessage(message, "Open as Text");
    if (action === "Open as Text") await openAsText(uri, vscode);
    const error = new Error(message);
    error.code = "CSV_TABLE_EDITOR_STREAMING_UNAVAILABLE";
    throw error;
  }

  return LargeCsvDocument.create(uri, stat.size, vscode, encodingApi);
}

class LargeCsvDocument {
  constructor(uri, size, encodingKey, delimiter, vscode, encodingApi) {
    this.isLargeFile = true;
    this.uri = uri;
    this.size = size;
    this.encodingKey = encodingKey;
    this.delimiter = delimiter;
    this.initialText = "";
    this._vscode = vscode;
    this._encodingApi = encodingApi;
    this._onDidChangeContent = new vscode.EventEmitter();
    this.onDidChangeContent = this._onDidChangeContent.event;
    this._pager = null;
  }

  static async create(uri, size, vscode, encodingApi) {
    const sample = await readSample(uri.fsPath);
    const detectionSample = trimSampleAtLineBoundary(sample);
    const encodingKey = encodingApi.detectEncoding(detectionSample);
    const delimiter = detectDelimiter(encodingApi.decode(detectionSample, encodingKey), uri.path);
    return new LargeCsvDocument(uri, size, encodingKey, delimiter, vscode, encodingApi);
  }

  get canEnableEditing() {
    return this.size <= HARD_MAX_FILE_SIZE_MB * MIB;
  }

  async setEncodingKey(encodingKey) {
    this.encodingKey = encodingKey;
    const sample = trimSampleAtLineBoundary(await readSample(this.uri.fsPath));
    this.delimiter = detectDelimiter(this._encodingApi.decode(sample, encodingKey), this.uri.path);
    await this.resetPager();
  }

  async resetPager() {
    if (this._pager) await this._pager.close();
    this._pager = new CsvStreamPager(
      this.uri.fsPath,
      this.encodingKey,
      this.delimiter,
      this._encodingApi
    );
    await this._pager.reset();
    return this._pager;
  }

  async nextPage(afterPage) {
    if (!this._pager) await this.resetPager();
    return this._pager.nextPage(afterPage);
  }

  async previousPage(beforePage) {
    if (!this._pager) await this.resetPager();
    return this._pager.previousPage(beforePage);
  }

  async reopenWithEncoding(encodingKey) {
    await this.setEncodingKey(encodingKey);
  }

  setEncodingKeySync(encodingKey) {
    this.encodingKey = encodingKey;
  }

  async save() {
    await this._vscode.window.showInformationMessage(
      "Large-file preview is read-only. Use Enable Editing when available, or edit the file with a streaming tool."
    );
  }

  async saveAs() {
    return this.save();
  }

  async revert() {
    await this.resetPager();
  }

  async backup(destination) {
    return { id: destination.toString(), delete: async () => {} };
  }

  async getCurrentText() {
    throw new Error("Large-file preview does not keep the complete file in memory.");
  }

  dispose() {
    if (this._pager) void this._pager.close();
    this._onDidChangeContent.dispose();
  }
}

class CsvStreamPager {
  constructor(filePath, encodingKey, delimiter, encodingApi) {
    this.filePath = filePath;
    this.encodingKey = encodingKey;
    this.delimiter = delimiter;
    this.encodingApi = encodingApi;
    this.stream = null;
    this.iterator = null;
    this.decoder = null;
    this.parser = null;
    this.done = false;
    this.header = null;
    this.pageNumber = 0;
    this.rowsSeen = 0;
    this.cacheHandle = null;
    this.cachePath = null;
    this.cacheOffset = 0;
    this.cacheEntries = new Map();
  }

  async reset() {
    await this.close();
    this.stream = fs.createReadStream(this.filePath, { highWaterMark: STREAM_CHUNK_BYTES });
    this.iterator = this.stream[Symbol.asyncIterator]();
    this.decoder = this.encodingApi.createDecoder(this.encodingKey);
    this.parser = new StreamingCsvParser(this.delimiter);
    this.done = false;
    this.header = null;
    this.pageNumber = 0;
    this.rowsSeen = 0;
    this.cachePath = path.join(
      os.tmpdir(),
      `csv-table-editor-${crypto.randomUUID()}.pages`
    );
    this.cacheHandle = await fs.promises.open(this.cachePath, "w+");
    this.cacheOffset = 0;
    this.cacheEntries = new Map();
  }

  async nextPage(afterPage = this.pageNumber) {
    if (!this.iterator) await this.reset();
    const targetPage = Number.isInteger(afterPage) ? afterPage + 1 : this.pageNumber + 1;
    if (targetPage <= this.pageNumber) return this.readCachedPage(targetPage);
    if (targetPage !== this.pageNumber + 1) return null;

    let rows;
    if (this.header === null) {
      const firstRows = await this.takeRows(PAGE_ROWS + 1);
      this.header = firstRows.shift() || [""];
      rows = firstRows;
    } else {
      rows = await this.takeRows(PAGE_ROWS);
    }

    const columnCount = rows.reduce((maximum, row) => Math.max(maximum, row.length), this.header.length);
    while (this.header.length < columnCount) this.header.push(`Column ${this.header.length + 1}`);

    this.pageNumber++;
    const startRow = this.rowsSeen + 2;
    this.rowsSeen += rows.length;
    const endRow = this.rowsSeen + 1;
    const page = {
      header: this.header,
      rows,
      pageNumber: this.pageNumber,
      startRow: rows.length ? startRow : 0,
      endRow: rows.length ? endRow : 0,
      done: this.done && this.parser.queuedRows === 0,
      truncatedCells: this.parser.truncatedCells,
      truncatedColumns: this.parser.truncatedColumns,
    };
    await this.cachePage(page);
    return page;
  }

  async previousPage(beforePage) {
    const targetPage = Number(beforePage) - 1;
    if (!Number.isInteger(targetPage) || targetPage < 1) return null;
    return this.readCachedPage(targetPage);
  }

  async cachePage(page) {
    if (!this.cacheHandle) throw new Error("Large-file page cache is unavailable.");
    const encoded = Buffer.from(JSON.stringify(page), "utf8");
    const offset = this.cacheOffset;
    await this.cacheHandle.write(encoded, 0, encoded.length, offset);
    this.cacheEntries.set(page.pageNumber, { offset, length: encoded.length });
    this.cacheOffset += encoded.length;
  }

  async readCachedPage(pageNumber) {
    const entry = this.cacheEntries.get(pageNumber);
    if (!entry || !this.cacheHandle) return null;
    const encoded = Buffer.allocUnsafe(entry.length);
    const { bytesRead } = await this.cacheHandle.read(
      encoded,
      0,
      encoded.length,
      entry.offset
    );
    if (bytesRead !== encoded.length) {
      throw new Error(`Could not restore cached CSV preview page ${pageNumber}.`);
    }
    return JSON.parse(encoded.toString("utf8"));
  }

  async takeRows(count) {
    let bytesSinceYield = 0;
    while (this.parser.queuedRows < count && !this.done) {
      const item = await this.iterator.next();
      if (item.done) {
        const tail = this.decoder.end();
        if (tail) this.parser.push(tail);
        this.parser.finish();
        this.done = true;
        break;
      }
      const decoded = this.decoder.write(item.value);
      if (decoded) this.parser.push(decoded);
      bytesSinceYield += item.value.length;
      if (bytesSinceYield >= STREAM_YIELD_BYTES) {
        bytesSinceYield = 0;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    return this.parser.takeRows(count);
  }

  async close() {
    if (this.stream) this.stream.destroy();
    this.stream = null;
    this.iterator = null;
    const cacheHandle = this.cacheHandle;
    const cachePath = this.cachePath;
    this.cacheHandle = null;
    this.cachePath = null;
    this.cacheEntries = new Map();
    if (cacheHandle) await cacheHandle.close();
    if (cachePath) {
      try {
        await fs.promises.unlink(cachePath);
      } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }
    }
  }
}

class StreamingCsvParser {
  constructor(delimiter) {
    this.delimiter = delimiter;
    this.rows = [];
    this.row = [];
    this.field = "";
    this.inQuotes = false;
    this.afterQuote = false;
    this.skipLf = false;
    this.hasPendingData = false;
    this.fieldWasTruncated = false;
    this.rowPreviewChars = 0;
    this.truncatedCells = 0;
    this.truncatedColumns = false;
  }

  get queuedRows() {
    return this.rows.length;
  }

  push(text) {
    for (const character of text) {
      if (this.skipLf) {
        this.skipLf = false;
        if (character === "\n") continue;
      }

      if (this.inQuotes) {
        if (this.afterQuote) {
          if (character === '"') {
            this.append('"');
            this.afterQuote = false;
            continue;
          }
          this.inQuotes = false;
          this.afterQuote = false;
          this.processOutsideQuotes(character);
          continue;
        }
        if (character === '"') this.afterQuote = true;
        else this.append(character);
        continue;
      }

      this.processOutsideQuotes(character);
    }
  }

  processOutsideQuotes(character) {
    if (character === '"') {
      this.inQuotes = true;
      this.hasPendingData = true;
    } else if (character === this.delimiter) {
      this.finishField();
      this.hasPendingData = true;
    } else if (character === "\r") {
      this.finishRow();
      this.skipLf = true;
    } else if (character === "\n") {
      this.finishRow();
    } else {
      this.append(character);
    }
  }

  append(character) {
    this.hasPendingData = true;
    if (
      this.row.length < MAX_PREVIEW_COLUMNS &&
      this.field.length < MAX_PREVIEW_CELL_CHARS &&
      this.rowPreviewChars + this.field.length < MAX_PREVIEW_ROW_CHARS
    ) this.field += character;
    else this.fieldWasTruncated = true;
  }

  finishField() {
    if (this.row.length >= MAX_PREVIEW_COLUMNS) {
      this.truncatedColumns = true;
      this.field = "";
      this.fieldWasTruncated = false;
      return;
    }
    let value = this.field;
    if (this.fieldWasTruncated) {
      value += "… [preview truncated]";
      this.truncatedCells++;
    }
    this.row.push(value);
    this.rowPreviewChars += value.length;
    this.field = "";
    this.fieldWasTruncated = false;
  }

  finishRow() {
    this.finishField();
    this.rows.push(this.row);
    this.row = [];
    this.rowPreviewChars = 0;
    this.hasPendingData = false;
  }

  finish() {
    if (this.afterQuote) {
      this.afterQuote = false;
      this.inQuotes = false;
    }
    if (this.hasPendingData || this.field.length > 0 || this.row.length > 0) this.finishRow();
  }

  takeRows(count) {
    return this.rows.splice(0, count);
  }
}

async function resolveLargeFileEditor(document, panel, vscode, encodingApi) {
  panel.webview.options = { enableScripts: true };
  panel.webview.html = getLargeFileWebviewHtml();
  let loading = false;

  const post = (message) => panel.webview.postMessage(message);
  const sendMetadata = () => post({
    type: "init",
    fileName: document.uri.path.split("/").pop() || "file.csv",
    fileSize: formatBytes(document.size),
    encodingLabel: encodingApi.findEncoding(document.encodingKey).label,
    delimiterLabel: delimiterLabel(document.delimiter),
    fontFamily: getFontFamily(vscode),
    canEnableEditing: document.canEnableEditing,
    hardLimit: HARD_MAX_FILE_SIZE_MB,
  });
  const loadPage = async (mode, adjacentPage) => {
    if (loading) return;
    loading = true;
    post({ type: "loading", loading: true });
    try {
      let page;
      if (mode === "replace") {
        await document.resetPager();
        page = await document.nextPage();
      } else if (mode === "prepend") {
        page = await document.previousPage(adjacentPage);
      } else {
        page = await document.nextPage(adjacentPage);
      }
      if (page) post({ type: "page", mode, ...page });
    } catch (error) {
      post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      loading = false;
      post({ type: "loading", loading: false });
    }
  };

  const messageSubscription = panel.webview.onDidReceiveMessage(async (message) => {
    switch (message.type) {
      case "ready":
        sendMetadata();
        await loadPage("replace");
        break;
      case "nextPage":
        await loadPage("append", message.afterPage);
        break;
      case "previousPage":
        await loadPage("prepend", message.beforePage);
        break;
      case "restart":
        await loadPage("replace");
        break;
      case "pickEncoding": {
        const items = encodingApi.SUPPORTED_ENCODINGS.map((encoding) => ({
          label: encoding.label,
          encoding,
        }));
        const selected = await vscode.window.showQuickPick(items, {
          title: "Reopen large CSV preview with encoding",
          placeHolder: "Choose an encoding",
        });
        if (selected) {
          await document.setEncodingKey(encodingApi.encodingKey(selected.encoding));
          sendMetadata();
          await loadPage("replace");
        }
        break;
      }
      case "openAsText":
        await openAsText(document.uri, vscode);
        break;
      case "enableEditing":
        await requestEditableReopen(document, vscode);
        break;
    }
  });

  const fontSubscription = watchFontFamily(vscode, panel.webview);
  panel.onDidDispose(() => {
    messageSubscription.dispose();
    fontSubscription.dispose();
  });
}

async function requestEditableReopen(document, vscode) {
  if (!document.canEnableEditing) {
    await vscode.window.showWarningMessage(
      `Full-grid editing is unavailable above ${HARD_MAX_FILE_SIZE_MB} MiB. ` +
      "This file remains available in the paged read-only preview."
    );
    return;
  }

  const size = formatBytes(document.size);
  const action = await vscode.window.showWarningMessage(
    `Enable full in-memory editing for ${size}? This can consume several times the file size in memory.`,
    { modal: true },
    "Enable Editing"
  );
  if (action !== "Enable Editing") return;

  EDITABLE_OVERRIDES.add(document.uri.toString());
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await vscode.commands.executeCommand("vscode.openWith", document.uri, "csvTableEditor.editor");
}

async function openAsText(uri, vscode) {
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await vscode.commands.executeCommand("vscode.openWith", uri, "default");
}

async function readSample(filePath) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function trimSampleAtLineBoundary(sample) {
  if (sample.length < SAMPLE_BYTES) return sample;
  const lineFeed = sample.lastIndexOf(0x0a);
  if (lineFeed < sample.length / 2) return sample.subarray(0, sample.length - 4);
  let end = lineFeed + 1;
  if (sample[end] === 0) end++;
  return sample.subarray(0, end);
}

function detectDelimiter(text, uriPath = "") {
  if (/\.tsv$/i.test(uriPath)) return "\t";
  const lines = text.split(/\r?\n/).filter(Boolean).slice(0, 30);
  let bestDelimiter = ",";
  let bestScore = -1;
  for (const delimiter of [",", "\t", ";", "|"]) {
    const counts = lines.map((line) => countUnquoted(line, delimiter));
    const positive = counts.filter((count) => count > 0);
    if (positive.length === 0) continue;
    const frequencies = new Map();
    for (const count of positive) frequencies.set(count, (frequencies.get(count) || 0) + 1);
    const consistency = Math.max(...frequencies.values());
    const score = consistency * 100 + positive.length;
    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = delimiter;
    }
  }
  return bestDelimiter;
}

function countUnquoted(line, delimiter) {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '"') {
      if (quoted && line[index + 1] === '"') index++;
      else quoted = !quoted;
    } else if (!quoted && line[index] === delimiter) count++;
  }
  return count;
}

function delimiterLabel(delimiter) {
  if (delimiter === "\t") return "Tab";
  if (delimiter === ",") return "Comma";
  if (delimiter === ";") return "Semicolon";
  return delimiter;
}

function getLargeFileWebviewHtml() {
  const nonce = crypto.randomBytes(16).toString("base64");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; display: flex; flex-direction: column; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--csv-table-font-family, var(--vscode-font-family)); }
  #toolbar { z-index: 5; flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 7px 10px; background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-panel-border); }
  #toolbar button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 4px 10px; border-radius: 3px; cursor: pointer; }
  #toolbar button:hover { background: var(--vscode-button-hoverBackground); }
  #toolbar button:disabled { opacity: .5; cursor: default; }
  #encoding { color: var(--vscode-textLink-foreground); background: transparent !important; padding: 2px 4px !important; text-decoration: underline; }
  #filter { min-width: 170px; padding: 4px 7px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  .spacer { flex: 1; }
  .muted { color: var(--vscode-descriptionForeground); font-size: .9em; }
  #readonly { color: var(--vscode-descriptionForeground); white-space: nowrap; }
  #error { display: none; color: var(--vscode-errorForeground); padding: 8px 10px; }
  #table-wrap { overflow: auto; flex: 1 1 auto; min-height: 0; }
  table { border-collapse: collapse; min-width: 100%; white-space: nowrap; }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 3px 7px; max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
  thead { position: sticky; top: 0; z-index: 2; background: var(--vscode-editorWidget-background); }
  th.row-number { position: sticky; left: 0; z-index: 1; text-align: right; color: var(--vscode-descriptionForeground); background: var(--vscode-editorWidget-background); }
  thead th.column-header { cursor: pointer; user-select: none; }
  tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
  th.search-column,
  td.search-column { background: var(--vscode-list-inactiveSelectionBackground); }
  td.match { background: var(--vscode-editor-findMatchBackground) !important; }
  td.match-current { background: var(--vscode-editor-findMatchHighlightBackground, var(--vscode-editor-findMatchBackground)) !important; outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
  #status { min-width: 130px; }
</style>
</head>
<body>
  <div id="toolbar">
    <strong id="file-name"></strong>
    <span class="muted" id="file-size"></span>
    <button id="encoding" title="Choose another encoding"></button>
    <span class="muted" id="delimiter"></span>
    <input id="filter" type="search" placeholder="Find in loaded rows">
    <span class="muted" id="filter-count"></span>
    <span class="muted" id="search-scope"></span>
    <span class="spacer"></span>
    <span class="muted" id="status"></span>
    <span id="readonly">Read-only preview</span>
    <button id="edit">Enable Editing</button>
  </div>
  <div id="error"></div>
  <div id="table-wrap"><table><thead></thead><tbody></tbody></table></div>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  const maximumWindowRows = 500;
  const autoloadDistance = 400;
  const filterDelayMs = 150;
  let loading = false;
  let pageRequested = false;
  let reachedEnd = false;
  let firstPageNumber = 0;
  let lastPageNumber = 0;
  let lastScrollTop = 0;
  let fullEditingAvailable = false;
  let fullEditingHardLimit = 511;
  let filterTimer = 0;
  let autoloadFrame = 0;
  let selectedSearchColumn = null;
  let selectedColumnCells = [];
  let matches = [];
  let matchIndex = -1;
  let currentMatchCell = null;

  function applyFontFamily(value) {
    const fontFamily = typeof value === 'string' && value.trim()
      ? value.trim()
      : 'var(--vscode-font-family)';
    document.documentElement.style.setProperty('--csv-table-font-family', fontFamily);
  }

  function render(page) {
    const head = document.querySelector('thead');
    const body = document.querySelector('tbody');
    const tableWrap = byId('table-wrap');
    const replacing = page.mode === 'replace';
    const prepending = page.mode === 'prepend';
    if (replacing || !head.firstChild) {
      head.replaceChildren();
      const headerRow = document.createElement('tr');
      const corner = document.createElement('th');
      corner.className = 'row-number';
      corner.textContent = '#';
      headerRow.appendChild(corner);
      page.header.forEach((value, column) => {
        const cell = document.createElement('th');
        cell.className = 'column-header';
        cell.dataset.columnIndex = String(column);
        cell.textContent = value;
        cell.title = 'Click to search column ' + (value || String(column + 1)) + ' only';
        headerRow.appendChild(cell);
      });
      head.appendChild(headerRow);
    }
    if (replacing) body.replaceChildren();

    const fragment = document.createDocumentFragment();
    page.rows.forEach((row, index) => {
      const tr = document.createElement('tr');
      tr.dataset.rowNumber = String(page.startRow + index);
      tr.dataset.pageNumber = String(page.pageNumber);
      tr.dataset.pageDone = String(page.done);
      const number = document.createElement('th');
      number.className = 'row-number';
      number.textContent = String(page.startRow + index);
      tr.appendChild(number);
      const columns = Math.max(page.header.length, row.length);
      for (let column = 0; column < columns; column++) {
        const value = row[column] == null ? '' : row[column];
        const cell = document.createElement('td');
        cell.textContent = value;
        // The tooltip is attached on first hover instead; see below.
        tr.appendChild(cell);
      }
      fragment.appendChild(tr);
    });
    if (prepending) body.insertBefore(fragment, body.firstChild);
    else body.appendChild(fragment);

    const rowHeight = body.rows.length ? body.rows[0].getBoundingClientRect().height : 0;
    let removedHeight = 0;
    const addedHeight = prepending ? rowHeight * page.rows.length : 0;
    // body.rows is live, so collect the doomed rows before detaching any of
    // them; re-reading the collection after every removal is quadratic.
    if (body.rows.length > maximumWindowRows && prepending) {
      const pageToRemove = body.rows[body.rows.length - 1].dataset.pageNumber;
      const doomed = [];
      for (let index = body.rows.length - 1; index >= 0; index--) {
        if (body.rows[index].dataset.pageNumber !== pageToRemove) break;
        doomed.push(body.rows[index]);
      }
      for (const row of doomed) row.remove();
    } else if (body.rows.length > maximumWindowRows) {
      const pageToRemove = body.rows[0].dataset.pageNumber;
      const doomed = [];
      for (let index = 0; index < body.rows.length; index++) {
        if (body.rows[index].dataset.pageNumber !== pageToRemove) break;
        doomed.push(body.rows[index]);
      }
      for (const row of doomed) row.remove();
      removedHeight = rowHeight * doomed.length;
    }
    if (prepending && addedHeight > 0) tableWrap.scrollTop += addedHeight;
    else if (!replacing && removedHeight > 0) tableWrap.scrollTop = Math.max(0, tableWrap.scrollTop - removedHeight);
    else if (replacing) tableWrap.scrollTop = 0;

    syncSelectedSearchColumn();
    // A page arriving while nothing is searched has no highlights to redo.
    if (matches.length || byId('filter').value.trim()) runSearch(true);
    const visibleRows = body.rows;
    if (visibleRows.length) {
      const firstVisibleRow = visibleRows[0];
      const lastVisibleRow = visibleRows[visibleRows.length - 1];
      firstPageNumber = Number(firstVisibleRow.dataset.pageNumber);
      lastPageNumber = Number(lastVisibleRow.dataset.pageNumber);
      reachedEnd = lastVisibleRow.dataset.pageDone === 'true';
      byId('status').textContent = 'Rows ' + firstVisibleRow.dataset.rowNumber + '–' +
        lastVisibleRow.dataset.rowNumber + (reachedEnd ? ' · End' : '');
    } else {
      firstPageNumber = 0;
      lastPageNumber = 0;
      reachedEnd = page.done;
      byId('status').textContent = 'No data rows';
    }
    lastScrollTop = tableWrap.scrollTop;
    const notes = [];
    if (page.truncatedCells) notes.push(page.truncatedCells + ' long cells truncated in preview');
    if (page.truncatedColumns) notes.push('columns after 100 hidden');
    const readOnly = byId('readonly');
    readOnly.textContent = 'Read-only preview';
    readOnly.title = (fullEditingAvailable
      ? 'Scroll up or down to load nearby rows. Enable Editing is available for this file.'
      : 'Scroll up or down to load nearby rows. Full editing is unavailable above ' + fullEditingHardLimit + ' MiB.') +
      (notes.length ? ' ' + notes.join('. ') + '.' : '');
  }

  function hasSelectedSearchColumn() {
    const headerRow = document.querySelector('thead tr');
    return Number.isInteger(selectedSearchColumn) && selectedSearchColumn >= 0 &&
      headerRow !== null && selectedSearchColumn + 1 < headerRow.cells.length;
  }

  function selectedSearchColumnLabel() {
    if (!hasSelectedSearchColumn()) return '';
    const header = document.querySelector('thead tr').cells[selectedSearchColumn + 1];
    return header.textContent.trim() || String(selectedSearchColumn + 1);
  }

  function updateSearchScope() {
    const scoped = hasSelectedSearchColumn();
    const label = scoped ? selectedSearchColumnLabel() : '';
    byId('filter').placeholder = scoped
      ? 'Find in column ' + label
      : 'Find in loaded rows';
    byId('filter').title = scoped
      ? 'Searching column ' + label + ' only; click its column header again to search all loaded rows'
      : 'Searching all loaded rows; click a column header to limit the search';
    byId('search-scope').textContent = scoped ? 'Column ' + label + ' only' : '';
  }

  function syncSelectedSearchColumn() {
    for (const cell of selectedColumnCells) cell.classList.remove('search-column');
    selectedColumnCells = [];
    if (!hasSelectedSearchColumn()) selectedSearchColumn = null;
    if (hasSelectedSearchColumn()) {
      const header = document.querySelector('thead tr').cells[selectedSearchColumn + 1];
      header.classList.add('search-column');
      selectedColumnCells.push(header);
      const rows = document.querySelector('tbody').rows;
      for (let index = 0; index < rows.length; index++) {
        const cell = rows[index].cells[selectedSearchColumn + 1];
        if (cell) {
          cell.classList.add('search-column');
          selectedColumnCells.push(cell);
        }
      }
    }
    updateSearchScope();
  }

  function clearSearchHighlights() {
    // matches already holds every highlighted cell, so no table query is needed.
    for (const cell of matches) cell.classList.remove('match', 'match-current');
    matches = [];
    currentMatchCell = null;
  }

  function focusMatch() {
    if (currentMatchCell) currentMatchCell.classList.remove('match-current');
    currentMatchCell = null;
    const cell = matches[matchIndex];
    if (!cell) return;
    cell.classList.add('match-current');
    currentMatchCell = cell;
    if (typeof cell.scrollIntoView === 'function') {
      cell.scrollIntoView({ block: 'center', inline: 'center' });
    }
    byId('filter-count').textContent = (matchIndex + 1) + '/' + matches.length + ' results';
  }

  function runSearch(keepIndex) {
    clearSearchHighlights();
    const needle = byId('filter').value.trim().toLocaleLowerCase();
    matches = [];
    if (!needle) {
      matchIndex = -1;
      byId('filter-count').textContent = '';
      return;
    }
    const scopedColumn = hasSelectedSearchColumn() ? selectedSearchColumn : -1;
    const rows = document.querySelector('tbody').rows;
    for (const row of rows) {
      // cells[0] is the row-number header; reading the live list avoids one
      // selector query per row.
      const cells = row.cells;
      const start = scopedColumn >= 0 ? scopedColumn + 1 : 1;
      const end = scopedColumn >= 0 ? Math.min(scopedColumn + 2, cells.length) : cells.length;
      for (let index = start; index < end; index++) {
        const cell = cells[index];
        if (cell.textContent.toLocaleLowerCase().includes(needle)) {
          cell.classList.add('match');
          matches.push(cell);
        }
      }
    }
    if (!matches.length) {
      matchIndex = -1;
      byId('filter-count').textContent = '0 results';
      return;
    }
    if (!keepIndex || matchIndex < 0 || matchIndex >= matches.length) matchIndex = 0;
    focusMatch();
  }

  function stepMatch(delta) {
    if (!matches.length) return;
    matchIndex = (matchIndex + delta + matches.length) % matches.length;
    focusMatch();
  }

  function selectSearchColumn(column) {
    selectedSearchColumn = selectedSearchColumn === column ? null : column;
    syncSelectedSearchColumn();
    runSearch(false);
  }

  function scheduleSearch() {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => runSearch(false), filterDelayMs);
  }

  function requestNextPage() {
    if (loading || pageRequested || reachedEnd || !lastPageNumber) return;
    pageRequested = true;
    vscode.postMessage({ type: 'nextPage', afterPage: lastPageNumber });
  }

  function requestPreviousPage() {
    if (loading || pageRequested || firstPageNumber <= 1) return;
    pageRequested = true;
    vscode.postMessage({ type: 'previousPage', beforePage: firstPageNumber });
  }

  function maybeLoadAdjacentPage() {
    const tableWrap = byId('table-wrap');
    const scrollingUp = tableWrap.scrollTop < lastScrollTop;
    const remaining = tableWrap.scrollHeight - tableWrap.scrollTop - tableWrap.clientHeight;
    if (scrollingUp && tableWrap.scrollTop <= autoloadDistance) requestPreviousPage();
    else if (!scrollingUp && remaining <= autoloadDistance) requestNextPage();
    lastScrollTop = tableWrap.scrollTop;
  }

  function scheduleMaybeLoadMore() {
    if (typeof requestAnimationFrame !== 'function') {
      maybeLoadAdjacentPage();
      return;
    }
    if (autoloadFrame) return;
    autoloadFrame = requestAnimationFrame(() => {
      autoloadFrame = 0;
      maybeLoadAdjacentPage();
    });
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'init') {
      byId('file-name').textContent = message.fileName;
      byId('file-size').textContent = message.fileSize;
      byId('encoding').textContent = message.encodingLabel;
      byId('delimiter').textContent = message.delimiterLabel;
      applyFontFamily(message.fontFamily);
      fullEditingAvailable = message.canEnableEditing;
      fullEditingHardLimit = message.hardLimit;
      byId('edit').hidden = !message.canEnableEditing;
      byId('readonly').title = message.canEnableEditing
        ? 'Read-only large-file preview. Enable Editing is available for this file.'
        : 'Read-only large-file preview. Full editing is unavailable above ' + message.hardLimit + ' MiB.';
    } else if (message.type === 'fontFamily') {
      applyFontFamily(message.fontFamily);
    } else if (message.type === 'page') {
      byId('error').style.display = 'none';
      render(message);
    } else if (message.type === 'loading') {
      loading = message.loading;
      if (!loading) pageRequested = false;
      byId('edit').disabled = message.loading;
      if (message.loading) byId('status').textContent = 'Loading…';
    } else if (message.type === 'error') {
      byId('error').textContent = message.message;
      byId('error').style.display = 'block';
    }
  });

  byId('filter').addEventListener('input', scheduleSearch);
  byId('filter').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      stepMatch(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      byId('filter').value = '';
      runSearch(false);
      byId('filter').blur();
    }
  });
  document.querySelector('thead').addEventListener('click', event => {
    const column = event.target.closest('th[data-column-index]');
    if (column) selectSearchColumn(Number(column.dataset.columnIndex));
  });
  window.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'f') {
      event.preventDefault();
      byId('filter').focus();
      byId('filter').select();
    }
  });
  // Give a cell its tooltip the first time it is hovered. Titling every cell
  // of every page up front costs a third of the page-build time, for tooltips
  // the reader will almost never look at.
  byId('table-wrap').addEventListener('mouseover', event => {
    const cell = event.target.closest('td');
    if (!cell || cell.title) return;
    const value = cell.textContent;
    if (value && value.length <= 256) cell.title = value;
  }, { passive: true });
  byId('table-wrap').addEventListener('scroll', scheduleMaybeLoadMore, { passive: true });
  byId('encoding').addEventListener('click', () => vscode.postMessage({ type: 'pickEncoding' }));
  byId('edit').addEventListener('click', () => vscode.postMessage({ type: 'enableEditing' }));
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}

module.exports = {
  LargeCsvDocument,
  CsvStreamPager,
  StreamingCsvParser,
  createLargeDocumentIfNeeded,
  resolveLargeFileEditor,
  detectDelimiter,
  getLargeFileWebviewHtml,
  requestEditableReopen,
  trimSampleAtLineBoundary,
};
