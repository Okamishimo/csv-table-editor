"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const {
  HARD_MAX_FILE_SIZE_MB,
  clampLimit,
  formatBytes,
} = require("./large-file-guard");
const {
  getFontFamily,
  watchFontFamily,
} = require("./font-settings");
const { buildFileIndex } = require("./large-file-index");

const MIB = 1024 * 1024;
const SAMPLE_BYTES = 256 * 1024;
const PAGE_ROWS = 100;
const STREAM_CHUNK_BYTES = 64 * 1024;
const STREAM_YIELD_BYTES = 256 * 1024;
const MAX_PREVIEW_COLUMNS = 100;
const MAX_PREVIEW_CELL_CHARS = 4_096;
const MAX_PREVIEW_ROW_CHARS = 32_768;
const EDITABLE_OVERRIDES = new Set();
/** Positions kept for one whole-file search. Enough to navigate, bounded so a
 *  query matching most of a multi-gigabyte file cannot exhaust the host. */
const SEARCH_MATCH_LIMIT = 20000;
/** How often a running scan reports what it has found so far. */
const SEARCH_REPORT_ROWS = 4000;
/** How often a running scan shows the reader the page it is looking at. */
const SCAN_FOLLOW_INTERVAL_MS = 200;
/**
 * How much of the file's pages to keep. Once the file has been indexed any page
 * can be re-read from its offset, so the cache is only there to make the pages
 * near the reader free. Both limits are needed: pages are usually small, but a
 * preview row may hold 32,768 characters.
 */
const PAGE_CACHE_MAX_BYTES = 8 * MIB;
const PAGE_CACHE_MAX_PAGES = 512;

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
    this._index = null;
    this._indexToken = 0;
  }

  get totalRows() {
    return this._index && this._index.complete ? this._index.totalRows : 0;
  }

  get indexComplete() {
    return Boolean(this._index && this._index.complete);
  }

  /**
   * Read the file once to learn how many rows it has and where each page
   * begins. The preview needs the count for a scrollbar that means something,
   * and the offsets so the reader can drag it anywhere.
   */
  async buildIndex(hooks = {}) {
    const token = ++this._indexToken;
    const index = await buildFileIndex(this.uri.fsPath, this.encodingKey, PAGE_ROWS, {
      cancelled: () => token !== this._indexToken || (hooks.cancelled ? hooks.cancelled() : false),
      progress: hooks.progress,
    });
    if (token !== this._indexToken || !index.complete) return null;
    this._index = index;
    if (this._pager) this._pager.index = index;
    return index;
  }

  cancelIndex() {
    this._indexToken++;
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
    // Row boundaries are found in the file's own units, so a different encoding
    // means a different index.
    this.cancelIndex();
    this._index = null;
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
    this._pager.index = this._index;
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

  async pageAt(pageNumber) {
    if (!this._pager) await this.resetPager();
    return this._pager.pageAt(pageNumber);
  }

  /** The page holding a display row number, once the file has been indexed. */
  async pageForRow(rowNumber) {
    if (!this._index) return null;
    const pageNumber = this._index.pageForRow(rowNumber);
    return pageNumber === null ? null : this.pageAt(pageNumber);
  }

  get rowsSeen() {
    return this._pager ? this._pager.rowsSeen : 0;
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
    this.cancelIndex();
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
    /** Recently read pages, oldest first: a Map iterates in insertion order,
     *  so re-inserting on a hit is all the recency tracking this needs. */
    this.pageCache = new Map();
    this.pageCacheBytes = 0;
    /** Page offsets, once the file has been indexed. */
    this.index = null;
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
    this.pageCache = new Map();
    this.pageCacheBytes = 0;
  }

  async nextPage(afterPage = this.pageNumber) {
    if (!this.iterator) await this.reset();
    const targetPage = Number.isInteger(afterPage) ? afterPage + 1 : this.pageNumber + 1;
    if (targetPage <= this.pageNumber) return this.pageAt(targetPage);
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
    this.cachePage(page);
    return page;
  }

  async previousPage(beforePage) {
    const targetPage = Number(beforePage) - 1;
    if (!Number.isInteger(targetPage) || targetPage < 1) return null;
    // Scrolling back past the cache is a seek, not a dead end.
    return this.pageAt(targetPage);
  }

  /**
   * Any page: from the cache when it has been read, by continuing the stream
   * when it is the next one, and otherwise by seeking straight to it once the
   * file has been indexed.
   */
  async pageAt(pageNumber) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1) return null;
    const cached = this.readCachedPage(pageNumber);
    if (cached) return cached;
    if (pageNumber === this.pageNumber + 1) return this.nextPage(this.pageNumber);
    return this.seekToPage(pageNumber);
  }

  /**
   * Restart the stream at a page's recorded offset. Page boundaries are record
   * boundaries, which is a safe place for the decoder to begin again.
   */
  async seekToPage(pageNumber) {
    if (!this.index || !this.index.hasPage(pageNumber)) return null;
    // Every page is shaped by the header, which lives before page 1.
    if (this.header === null) {
      const first = await this.nextPage(0);
      if (pageNumber === 1) return first;
      const cached = this.readCachedPage(pageNumber);
      if (cached) return cached;
    }

    if (this.stream) this.stream.destroy();
    this.stream = fs.createReadStream(this.filePath, {
      start: this.index.pageOffset(pageNumber),
      highWaterMark: STREAM_CHUNK_BYTES,
    });
    this.iterator = this.stream[Symbol.asyncIterator]();
    this.decoder = this.encodingApi.createDecoder(this.encodingKey);
    this.parser = new StreamingCsvParser(this.delimiter);
    this.done = false;
    this.pageNumber = pageNumber - 1;
    this.rowsSeen = (pageNumber - 1) * PAGE_ROWS;
    return this.nextPage(this.pageNumber);
  }

  cachePage(page) {
    if (this.pageCache.has(page.pageNumber)) return;
    // The header array is shared by every page and grows as wider rows appear,
    // so a cached page keeps the one it was built with.
    const entry = { page: { ...page, header: page.header.slice() }, bytes: pageBytes(page) };
    this.pageCache.set(page.pageNumber, entry);
    this.pageCacheBytes += entry.bytes;
    this.trimPageCache();
  }

  /** Drop the least recently used pages until the cache is within its limits. */
  trimPageCache() {
    while (
      this.pageCache.size > PAGE_CACHE_MAX_PAGES ||
      (this.pageCacheBytes > PAGE_CACHE_MAX_BYTES && this.pageCache.size > 1)
    ) {
      const oldest = this.pageCache.keys().next();
      if (oldest.done) return;
      this.pageCacheBytes -= this.pageCache.get(oldest.value).bytes;
      this.pageCache.delete(oldest.value);
    }
  }

  readCachedPage(pageNumber) {
    const entry = this.pageCache.get(pageNumber);
    if (!entry) return null;
    // Re-inserting moves it to the end, which is the most recently used.
    this.pageCache.delete(pageNumber);
    this.pageCache.set(pageNumber, entry);
    return entry.page;
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
    this.pageCache = new Map();
    this.pageCacheBytes = 0;
  }
}

/** Roughly what a page costs to keep, in bytes of UTF-16 string data. */
function pageBytes(page) {
  let bytes = 128;
  for (const row of page.rows) {
    bytes += 32;
    for (const value of row) bytes += value.length * 2 + 16;
  }
  return bytes;
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

/**
 * Walk the whole file for a query, reporting matches as they are found.
 *
 * Matches at or after `fromRow` are reported first, in file order, so
 * navigation continues from where the reader is. The ones before it are held
 * back and reported at the end, which is the wrap around the end of the file.
 * Either way the scan covers every row exactly once.
 *
 * Pages the scan passes are cached by the pager, so jumping to any match it
 * reported never re-reads the file.
 */
async function searchLargeFile(document, request, hooks) {
  const needle = typeof request.query === "string" ? request.query.trim().toLocaleLowerCase() : "";
  if (!needle) return;
  const column = Number.isInteger(request.column) && request.column >= 0 ? request.column : -1;
  const fromRow = Number.isFinite(request.fromRow) ? Number(request.fromRow) : 0;

  // The preview asks for only the next match, starting at the visible page.
  // pageAt uses the file index to seek directly; do not scan earlier pages just
  // to reorder their results later. No wrap: this request searches downward.
  if (request.firstOnly) {
    const fromPage = Number.isInteger(request.fromPage) && request.fromPage > 0
      ? request.fromPage : Math.max(1, Math.floor((fromRow - 2) / PAGE_ROWS) + 1);
    let scannedRows = 0;
    for (let pageNumber = fromPage;; pageNumber++) {
      if (hooks.cancelled()) return;
      const page = await hooks.serialize(() => document.pageAt(pageNumber));
      if (hooks.cancelled()) return;
      if (!page) break;
      if (hooks.onPage) hooks.onPage(page);
      for (const [index, row] of page.rows.entries()) {
        const r = page.startRow + index;
        if (r < fromRow) continue;
        scannedRows++;
        const first = column >= 0 ? column : 0;
        const last = column >= 0 ? Math.min(column + 1, row.length) : row.length;
        for (let c = first; c < last; c++) {
          if (row[c] == null || !String(row[c]).toLocaleLowerCase().includes(needle)) continue;
          hooks.report({ matches: [{ r, c, p: page.pageNumber }], done: true,
            total: 1, truncated: false, scannedRows });
          return;
        }
      }
      if (page.done) break;
      hooks.report({ matches: [], done: false, total: 0, truncated: false, scannedRows });
    }
    if (!hooks.cancelled()) hooks.report({ matches: [], done: true, total: 0, truncated: false, scannedRows });
    return;
  }

  const wrapped = [];
  let ahead = [];
  let total = 0;
  let scannedRows = 0;
  let rowsSinceReport = 0;
  let truncated = false;

  const report = (done) => {
    const matches = ahead;
    ahead = [];
    rowsSinceReport = 0;
    hooks.report({ matches, done, total, truncated, scannedRows });
  };

  for (let pageNumber = 1; !truncated; pageNumber++) {
    if (hooks.cancelled()) return;
    const page = await hooks.serialize(() => document.pageAt(pageNumber));
    if (!page) break;
    if (hooks.onPage) hooks.onPage(page);

    for (const [index, row] of page.rows.entries()) {
      const rowNumber = page.startRow + index;
      const first = column >= 0 ? column : 0;
      const last = column >= 0 ? Math.min(column + 1, row.length) : row.length;
      for (let c = first; c < last; c++) {
        const value = row[c];
        if (value == null || !String(value).toLocaleLowerCase().includes(needle)) continue;
        total++;
        if (total > SEARCH_MATCH_LIMIT) { truncated = true; break; }
        const match = { r: rowNumber, c: c, p: page.pageNumber };
        if (rowNumber >= fromRow) ahead.push(match);
        else wrapped.push(match);
      }
      if (truncated) break;
    }

    scannedRows += page.rows.length;
    rowsSinceReport += page.rows.length;
    // Report often enough that the reader can jump to an early match while the
    // rest of the file is still being read.
    if (!truncated && (ahead.length > 0 || rowsSinceReport >= SEARCH_REPORT_ROWS)) report(false);
    if (page.done) break;
  }

  if (hooks.cancelled()) return;
  if (truncated) total = SEARCH_MATCH_LIMIT;
  // The wrap: everything above where the reader started, in file order.
  ahead = ahead.concat(wrapped);
  report(true);
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
  // One reader at a time. The pager owns a single forward stream, so a running
  // search and the reader's scrolling must take turns rather than interleave.
  let queue = Promise.resolve();
  const serialize = (task) => {
    const run = queue.then(() => task());
    queue = run.then(() => {}, () => {});
    return run;
  };

  let searchToken = 0;
  const cancelSearch = () => { searchToken++; };

  let indexToken = 0;
  const startIndexing = () => {
    const token = ++indexToken;
    post({ type: "fileIndex", totalRows: 0, complete: false, indexedBytes: 0, size: document.size });
    void document.buildIndex({
      cancelled: () => token !== indexToken,
      progress: (bytes) => {
        if (token !== indexToken) return;
        post({ type: "fileIndex", totalRows: 0, complete: false, indexedBytes: bytes, size: document.size });
      },
    }).then((index) => {
      if (token !== indexToken || !index) return;
      post({
        type: "fileIndex",
        totalRows: index.totalRows,
        complete: true,
        indexedBytes: document.size,
        size: document.size,
      });
    }, () => {
      // A file that cannot be indexed still previews; the scrollbar just stays
      // bounded to the loaded window.
      if (token === indexToken) post({ type: "fileIndex", totalRows: 0, complete: false, failed: true });
    });
  };

  const loadPage = async (mode, adjacentPage, focus) => {
    if (loading) return;
    loading = true;
    post({ type: "loading", loading: true });
    try {
      let page;
      if (mode === "replace") {
        // A fresh stream invalidates every cached page, so any search built on
        // them is void as well.
        cancelSearch();
        await serialize(() => document.resetPager());
        page = await serialize(() => document.nextPage());
      } else if (mode === "prepend") {
        page = await serialize(() => document.previousPage(adjacentPage));
      } else if (mode === "goto") {
        page = await serialize(() => document.pageAt(adjacentPage));
      } else if (mode === "row") {
        page = await serialize(() => document.pageForRow(adjacentPage));
      } else {
        page = await serialize(() => document.nextPage(adjacentPage));
      }
      if (page) {
        // A jump replaces the window, but the reader already chose where to be:
        // dragging the scrollbar must not throw them back to the first row.
        const jumped = mode === "goto" || mode === "row";
        post({
          type: "page",
          mode: jumped ? "replace" : mode,
          ...page,
          focus: focus || null,
          keepScroll: mode === "row",
        });
      }
    } catch (error) {
      post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      loading = false;
      post({ type: "loading", loading: false });
    }
  };

  const runSearch = async (message) => {
    cancelSearch();
    const token = searchToken;
    post({ type: "searchStarted", query: message.query });
    try {
      let lastFollow = 0;
      await searchLargeFile(document, message, {
        serialize,
        cancelled: () => token !== searchToken,
        onPage: (page) => {
          if (token !== searchToken) return;
          // Show the reader where the scan has reached, rate limited so a fast
          // scan does not flood the Webview.
          const now = Date.now();
          if (now - lastFollow < SCAN_FOLLOW_INTERVAL_MS) return;
          lastFollow = now;
          // Same shape as every other page message, so the preview never has
          // to guess which fields a page carries.
          post({ type: "page", mode: "replace", ...page, focus: null, keepScroll: false, follow: true });
        },
        report: (update) => {
          if (token !== searchToken) return;
          post({ type: "searchMatches", query: message.query, ...update });
        },
      });
    } catch (error) {
      if (token !== searchToken) return;
      post({ type: "error", message: error instanceof Error ? error.message : String(error) });
      post({ type: "searchMatches", query: message.query, matches: [], done: true, total: 0, truncated: false, scannedRows: 0 });
    }
  };

  const messageSubscription = panel.webview.onDidReceiveMessage(async (message) => {
    switch (message.type) {
      case "ready":
        sendMetadata();
        // Indexing starts first: the preview waits for the whole file to be
        // read before it can be browsed, and says so from the first frame.
        startIndexing();
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
      case "searchFile":
        await runSearch(message);
        break;
      case "cancelSearch":
        cancelSearch();
        break;
      case "gotoMatch":
        await loadPage("goto", message.page, { row: message.row, column: message.column });
        break;
      case "gotoRow":
        await loadPage("row", message.row);
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
          // Row boundaries depend on the encoding, so the file is read again,
          // and the preview waits for that read as it did for the first one.
          startIndexing();
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
    cancelSearch();
    indexToken++;
    document.cancelIndex();
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
  #content { position: relative; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
  #table-wrap { overflow: auto; overflow-anchor: none; flex: 1 1 auto; min-height: 0; }
  /* The whole file is read before any of it can be scrolled, so the reader
     never drags a scrollbar whose length is still a guess. */
  #preparing { position: absolute; inset: 0; z-index: 4; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; background: var(--vscode-editor-background); color: var(--vscode-descriptionForeground); }
  #preparing[hidden] { display: none; }
  #preparing-bar { width: 240px; height: 6px; overflow: hidden; border: 1px solid var(--vscode-panel-border); border-radius: 3px; background: var(--vscode-editorWidget-background); }
  #preparing-fill { height: 100%; width: 0; background: var(--vscode-progressBar-background, var(--vscode-textLink-foreground)); }
  table { border-collapse: collapse; min-width: 100%; white-space: nowrap; }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 3px 7px; max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
  thead { position: sticky; top: 0; z-index: 2; background: var(--vscode-editorWidget-background); }
  th.row-number { position: sticky; left: 0; z-index: 1; text-align: right; color: var(--vscode-descriptionForeground); background: var(--vscode-editorWidget-background); }
  thead th.column-header { cursor: pointer; user-select: none; }
  #rows th.row-number { cursor: pointer; user-select: none; }
  #rows tr:hover td { background: var(--vscode-list-hoverBackground); }
  th.search-column,
  td.search-column { background: var(--vscode-list-inactiveSelectionBackground); }
  #rows tr.highlighted-row > td,
  #rows tr.highlighted-row > th { background: var(--vscode-list-inactiveSelectionBackground); }
  td.highlighted-cell { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
  td.match { background: var(--vscode-editor-findMatchBackground) !important; }
  td.match-current { background: var(--vscode-editor-findMatchHighlightBackground, var(--vscode-editor-findMatchBackground)) !important; outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
  #status { min-width: 130px; }
  /* The rows that are not loaded. They carry the height of everything outside
     the window, so the scrollbar measures the file rather than the window. */
  #space-above td, #space-below td {
    padding: 0; border: 0; height: 0; border-left: 1px solid var(--vscode-panel-border);
    background-image: repeating-linear-gradient(135deg,
      transparent 0 6px, var(--vscode-panel-border) 6px 7px);
    opacity: .35;
  }
</style>
</head>
<body>
  <div id="toolbar">
    <strong id="file-name"></strong>
    <span class="muted" id="file-size"></span>
    <button id="encoding" title="Choose another encoding"></button>
    <span class="muted" id="delimiter"></span>
    <input id="filter" type="search" placeholder="Find in file — press Enter">
    <span class="muted" id="filter-count"></span>
    <span class="muted" id="search-scope"></span>
    <span class="spacer"></span>
    <span class="muted" id="status"></span>
    <span id="readonly">Read-only preview</span>
    <button id="edit">Enable Editing</button>
  </div>
  <div id="error"></div>
  <div id="content">
    <div id="table-wrap"><table><thead></thead><tbody id="space-above"><tr><td></td></tr></tbody><tbody id="rows"></tbody><tbody id="space-below"><tr><td></td></tr></tbody></table></div>
    <div id="preparing" hidden>
      <div id="preparing-text">Reading the file…</div>
      <div id="preparing-bar"><div id="preparing-fill"></div></div>
      <span class="muted" id="preparing-percent">0%</span>
    </div>
  </div>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  const maximumWindowRows = 500;
  const autoloadDistance = 400;
  /** Rows kept between the edge of the window and the edge of the viewport
   *  before the next page is fetched. */
  const prefetchRows = 30;
  /** Data rows in the file, once the host has indexed it. Zero means unknown,
   *  and the preview falls back to describing only the loaded window. */
  let totalRows = 0;
  let indexedBytes = 0;
  let indexSize = 0;
  let indexComplete = false;
  let rowHeight = 0;
  /** While a scan runs the view follows it, until the reader takes over. */
  let following = false;
  const filterDelayMs = 150;
  /** How long the scroller must be still before its window is loaded. A wheel
   *  gesture emits events for as long as it lasts, and its momentum for longer
   *  still; loading each one would page through windows the reader has already
   *  left behind. */
  const scrollSettleMs = 120;
  let loading = false;
  let pageRequested = false;
  let reachedEnd = false;
  let firstPageNumber = 0;
  let lastPageNumber = 0;
  let lastScrollTop = 0;
  let fullEditingAvailable = false;
  let fullEditingHardLimit = 511;
  let filterTimer = 0;
  let scrollSettleTimer = 0;
  let scrollingUp = false;
  /** True while the host is still reading the file. Until it has finished,
   *  neither the row count nor the page offsets are known, so the preview shows
   *  its progress rather than a window the reader cannot navigate. */
  let preparing = false;
  let selectedSearchColumn = null;
  let selectedColumnCells = [];
  let highlightedRowElement = null;
  let highlightedCellElement = null;
  let highlightedColumnRule = null;
  let matches = [];
  let currentMatchCell = null;
  /** Whole-file matches in the order navigation visits them: from where the
   *  reader was when the search started, down to the end, then wrapping to the
   *  top. The host streams them in as it reads the file. */
  let fileMatches = [];
  let fileMatchIndex = -1;
  let fileSearchQuery = '';
  let fileSearchDone = false;
  let fileSearchTruncated = false;
  let fileScannedRows = 0;
  let pendingMatchFocus = null;
  /** The row the last jump asked for, so an answer that does not cover it is
   *  accepted rather than requested again and again. */
  let lastRequestedRow = -1;
  /** Whether the reader asked for this search, and may therefore be taken to
   *  its first result. A scan restarted by cancelling a column scope must not
   *  move them away from the cell they just clicked. */
  let fileSearchReveals = true;

  function applyFontFamily(value) {
    const fontFamily = typeof value === 'string' && value.trim()
      ? value.trim()
      : 'var(--vscode-font-family)';
    document.documentElement.style.setProperty('--csv-table-font-family', fontFamily);
  }

  function absoluteScrolling() {
    return totalRows > 0 && rowHeight > 0;
  }

  function measureRowHeight() {
    const rows = byId('rows').rows;
    if (!rows.length) return rowHeight;
    const height = rows[0].getBoundingClientRect().height;
    // Whole pixels: the spacers multiply this by millions of rows, and a
    // fraction repeated that often drifts the arithmetic away from the layout.
    return height > 0 ? Math.round(height) : rowHeight;
  }

  function setSpacer(id, height, columns) {
    const cell = byId(id).rows[0].cells[0];
    cell.style.height = Math.max(0, height) + 'px';
    if (columns) cell.colSpan = columns;
  }

  /** Give the unloaded parts of the file their height, so the scrollbar spans
   *  the whole file and the thumb says how much is left. */
  function updateSpacers() {
    const rows = byId('rows').rows;
    const columns = (document.querySelector('thead tr') || { cells: [] }).cells.length || 1;
    if (!absoluteScrolling() || !rows.length) {
      setSpacer('space-above', 0, columns);
      setSpacer('space-below', 0, columns);
      return;
    }
    const firstRow = Number(rows[0].dataset.rowNumber);
    const lastRow = Number(rows[rows.length - 1].dataset.rowNumber);
    // Data rows are numbered from 2, so the file holds rows 2 .. totalRows + 1.
    const above = (firstRow - 2) * rowHeight;
    setSpacer('space-above', above, columns);
    setSpacer('space-below', (totalRows + 1 - lastRow) * rowHeight, columns);
    correctSpacerDrift(rows[0], firstRow, above, columns);
  }

  /**
   * Where a row actually sits decides where the reader is, so put the first
   * rendered row exactly where the arithmetic expects it. Table layout rounds
   * heights its own way, and over millions of rows the two drift apart; left
   * uncorrected the preview asks for a window it is already showing, which is
   * a request that answers itself for ever.
   */
  function correctSpacerDrift(firstRowElement, firstRow, above, columns) {
    const tableWrap = byId('table-wrap');
    const wrapTop = tableWrap.getBoundingClientRect().top;
    const rowTop = firstRowElement.getBoundingClientRect().top;
    if (!Number.isFinite(wrapTop) || !Number.isFinite(rowTop)) return;
    const head = document.querySelector('thead').getBoundingClientRect().height || 0;
    const actual = rowTop - wrapTop + tableWrap.scrollTop;
    const expected = head + (firstRow - 2) * rowHeight;
    const drift = expected - actual;
    // Only worth correcting once it could put the reader on the wrong row.
    if (Math.abs(drift) < 0.5 || Math.abs(drift) > rowHeight * maximumWindowRows) return;
    setSpacer('space-above', above + drift, columns);
  }

  /** The data row at the top of the viewport. */
  function rowAtViewportTop() {
    const head = document.querySelector('thead').getBoundingClientRect().height || 0;
    const offset = Math.max(0, byId('table-wrap').scrollTop - head);
    return Math.min(totalRows + 1, Math.floor(offset / rowHeight) + 2);
  }

  function scrollToRow(row) {
    const head = document.querySelector('thead').getBoundingClientRect().height || 0;
    byId('table-wrap').scrollTop = Math.max(0, (row - 2) * rowHeight) + head;
  }

  function stopFollowing() {
    following = false;
  }

  function captureScrollAnchor(body, tableWrap, head) {
    const rows = body.rows;
    if (!rows.length) return null;
    const visibleTop = tableWrap.getBoundingClientRect().top + head.getBoundingClientRect().height;
    // Find the first row below the sticky header without scanning the table.
    let low = 0;
    let high = rows.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (rows[middle].getBoundingClientRect().bottom <= visibleTop) low = middle + 1;
      else high = middle;
    }
    const row = rows[low];
    return { row, top: row.getBoundingClientRect().top };
  }

  function render(page) {
    const head = document.querySelector('thead');
    const body = byId('rows');
    const tableWrap = byId('table-wrap');
    const replacing = page.mode === 'replace';
    const prepending = page.mode === 'prepend';
    // With the file's height on the spacers every row already sits at its own
    // offset, so inserting and evicting rows cannot move anything.
    const anchor = replacing || absoluteScrolling()
      ? null
      : captureScrollAnchor(body, tableWrap, head);
    const scrollLeft = tableWrap.scrollLeft;
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
    }
    rowHeight = measureRowHeight();
    updateSpacers();
    if (replacing) {
      if (page.follow && absoluteScrolling()) scrollToRow(page.startRow);
      // A jump the reader made by dragging the scrollbar is already where they
      // put it; only a genuinely new window starts at the top.
      else if (!page.keepScroll && !page.focus) tableWrap.scrollTop = 0;
    } else if (anchor && body.contains(anchor.row)) {
      // Measure the retained row after layout, including any browser scroll
      // clamping when a short final page makes the rolling window smaller.
      tableWrap.scrollTop += anchor.row.getBoundingClientRect().top - anchor.top;
    }
    tableWrap.scrollLeft = scrollLeft;

    if (highlightedRowElement && !body.contains(highlightedRowElement)) clearRowHighlight();
    syncSelectedSearchColumn();
    // A page arriving while nothing is searched has no highlights to redo.
    if (matches.length || byId('filter').value.trim()) runSearch();
    const visibleRows = body.rows;
    if (visibleRows.length) {
      const firstVisibleRow = visibleRows[0];
      const lastVisibleRow = visibleRows[visibleRows.length - 1];
      firstPageNumber = Number(firstVisibleRow.dataset.pageNumber);
      lastPageNumber = Number(lastVisibleRow.dataset.pageNumber);
      reachedEnd = lastVisibleRow.dataset.pageDone === 'true';
      byId('status').textContent = 'Rows ' + firstVisibleRow.dataset.rowNumber + '–' +
        lastVisibleRow.dataset.rowNumber + rowTotalLabel() + (reachedEnd ? ' · End' : '');
    } else {
      firstPageNumber = 0;
      lastPageNumber = 0;
      reachedEnd = page.done;
      byId('status').textContent = 'No data rows';
    }
    lastScrollTop = tableWrap.scrollTop;
    if (page.focus) {
      // This page was loaded to show one match; reveal it now that it exists.
      pendingMatchFocus = null;
      const cell = loadedCell(page.focus.row, page.focus.column);
      if (cell) {
        setCurrentMatchCell(cell);
        if (typeof cell.scrollIntoView === 'function') {
          cell.scrollIntoView({ block: 'center', inline: 'center' });
        }
        lastScrollTop = tableWrap.scrollTop;
      }
      updateMatchCount();
    }
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

  /** What the status line says about the size of the file. */
  function rowTotalLabel() {
    if (totalRows > 0) return ' of ' + totalRows.toLocaleString();
    if (indexSize > 0 && !indexComplete) {
      const percent = Math.min(99, Math.floor((indexedBytes / indexSize) * 100));
      return ' · counting rows ' + percent + '%';
    }
    return '';
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
      ? 'Find in column ' + label + ' — press Enter'
      : 'Find in file — press Enter';
    byId('filter').title = scoped
      ? 'Searching downward in column ' + label + ' only, stopping at the first match; click its column header again to search every column'
      : 'Press Enter to search downward from the current view; stops at the first match';
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
      const rows = byId('rows').rows;
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

  /** The cell for a file row and column, when that row is loaded. */
  function loadedCell(row, column) {
    const tr = byId('rows').querySelector('tr[data-row-number="' + row + '"]');
    // cells[0] is the row-number header, so data column c sits at c + 1.
    return tr ? tr.cells[column + 1] || null : null;
  }

  function setCurrentMatchCell(cell) {
    if (currentMatchCell) currentMatchCell.classList.remove('match-current');
    currentMatchCell = cell;
    if (!cell) return;
    if (!cell.classList.contains('match')) {
      cell.classList.add('match');
      matches.push(cell);
    }
    cell.classList.add('match-current');
  }

  function updateMatchCount() {
    const countEl = byId('filter-count');
    const query = byId('filter').value.trim();
    if (!query) { countEl.textContent = ''; return; }
    if (query !== fileSearchQuery) {
      // Nothing has been read for this query yet, so only say what is on screen.
      countEl.textContent = matches.length
        ? matches.length.toLocaleString() + ' on screen · Enter to search the file'
        : 'Enter to search the file';
      return;
    }
    const scanning = fileSearchDone ? '' : ' · searching… ' + fileScannedRows.toLocaleString() + ' rows';
    if (!fileMatches.length) {
      countEl.textContent = fileSearchDone ? '0 results' : 'Searching… ' + fileScannedRows.toLocaleString() + ' rows';
      return;
    }
    const total = fileMatches.length.toLocaleString() + (fileSearchTruncated ? '+' : '');
    const position = (fileMatchIndex < 0 ? 0 : fileMatchIndex) + 1;
    countEl.textContent = position + '/' + total + ' results' + scanning;
  }

  /** Highlight the query inside the loaded window. Never scrolls: paging must
   *  not move the reader, and navigation does its own scrolling. */
  function runSearch() {
    clearSearchHighlights();
    const needle = byId('filter').value.trim().toLocaleLowerCase();
    matches = [];
    if (!needle) { updateMatchCount(); return; }
    const scopedColumn = hasSelectedSearchColumn() ? selectedSearchColumn : -1;
    const rows = byId('rows').rows;
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
    const current = fileMatches[fileMatchIndex];
    if (current) setCurrentMatchCell(loadedCell(current.r, current.c));
    updateMatchCount();
  }

  /** Search downward from the first visible row, stopping at the first match. */
  function requestFileSearch(reveal) {
    fileSearchReveals = reveal !== false;
    const query = byId('filter').value.trim();
    const wasSearching = fileSearchQuery !== '';
    fileMatches = [];
    fileMatchIndex = -1;
    fileSearchDone = false;
    fileSearchTruncated = false;
    fileScannedRows = 0;
    pendingMatchFocus = null;
    fileSearchQuery = query;
    if (!query) {
      following = false;
      // Nothing was running, so there is nothing to call off.
      if (wasSearching) vscode.postMessage({ type: 'cancelSearch' });
      updateMatchCount();
      return;
    }
    const rows = byId('rows').rows;
    const measurable = rows.length && rows[0].getBoundingClientRect().height > 0;
    const anchor = measurable
      ? captureScrollAnchor(byId('rows'), byId('table-wrap'), document.querySelector('thead')) : null;
    const startRow = anchor ? anchor.row : rows[0];
    // A scrollbar jump may still be awaiting its window. Use that position
    // instead of the stale rendered rows when none of them covers the view.
    const fromRow = absoluteScrolling() && (!anchor ||
      anchor.row.getBoundingClientRect().bottom <= byId('table-wrap').getBoundingClientRect().top ||
      anchor.row.getBoundingClientRect().top >= byId('table-wrap').getBoundingClientRect().bottom)
      ? rowAtViewportTop() : startRow ? Number(startRow.dataset.rowNumber) : 2;
    const fromPage = absoluteScrolling() ? Math.max(1, Math.floor((fromRow - 2) / ${PAGE_ROWS}) + 1)
      : startRow ? Number(startRow.dataset.pageNumber) : 1;
    // Follow the scan while it sweeps, so the reader can see how far it has
    // reached; the first result, or any scrolling, hands control back.
    following = fileSearchReveals;
    vscode.postMessage({
      type: 'searchFile',
      query: query,
      column: hasSelectedSearchColumn() ? selectedSearchColumn : -1,
      fromRow: fromRow,
      fromPage: fromPage,
      firstOnly: true,
    });
    updateMatchCount();
  }

  /** Show the current whole-file match, loading its page when it is not here. */
  function revealCurrentMatch(scrollToMatch) {
    const match = fileMatches[fileMatchIndex];
    if (!match) { updateMatchCount(); return; }
    // There is a result to look at now, so stop chasing the scan.
    if (scrollToMatch) stopFollowing();
    const cell = loadedCell(match.r, match.c);
    if (cell) {
      setCurrentMatchCell(cell);
      if (scrollToMatch && typeof cell.scrollIntoView === 'function') {
        cell.scrollIntoView({ block: 'center', inline: 'center' });
      }
      updateMatchCount();
      return;
    }
    // Results arriving on their own leave the reader where they are.
    if (!scrollToMatch) { updateMatchCount(); return; }
    // The match is outside the loaded window. Its page was cached by the scan
    // that found it, so this does not re-read the file.
    pendingMatchFocus = match;
    updateMatchCount();
    vscode.postMessage({ type: 'gotoMatch', page: match.p, row: match.r, column: match.c });
  }

  function stepMatch(delta) {
    if (!fileMatches.length) return;
    fileMatchIndex = (fileMatchIndex + delta + fileMatches.length) % fileMatches.length;
    revealCurrentMatch(true);
  }

  function selectSearchColumn(column) {
    clearRowHighlight();
    selectedSearchColumn = selectedSearchColumn === column ? null : column;
    syncSelectedSearchColumn();
    // A different scope is a different result set. Read the file again only if
    // the reader had already asked for it; otherwise just repaint.
    if (fileSearchQuery) requestFileSearch(true);
    else discardFileMatches();
    runSearch();
  }

  function clearRowHighlight() {
    clearCellHighlight();
    if (highlightedRowElement) highlightedRowElement.classList.remove('highlighted-row');
    highlightedRowElement = null;
  }

  function highlightRow(row) {
    clearCellHighlight();
    if (highlightedRowElement === row) return;
    clearRowHighlight();
    highlightedRowElement = row;
    row.classList.add('highlighted-row');
    // Row highlighting is visual only: keep the query, scope and current match.
  }

  function clearCellHighlight() {
    if (highlightedCellElement) highlightedCellElement.classList.remove('highlighted-cell');
    highlightedCellElement = null;
    if (highlightedColumnRule) highlightedColumnRule.selectorText = ':not(*)';
  }

  function highlightCell(cell) {
    if (highlightedCellElement === cell) return;
    if (selectedSearchColumn !== null) {
      selectedSearchColumn = null;
      syncSelectedSearchColumn();
      // Cancel whole-column selection without scrolling away from the click.
      if (fileSearchQuery) requestFileSearch(false);
      else discardFileMatches();
      runSearch();
    }
    highlightRow(cell.parentElement);
    highlightedCellElement = cell;
    cell.classList.add('highlighted-cell');
    // One rule in the nonce-approved stylesheet paints the column, including
    // newly loaded rows, without scanning or adding classes to every cell.
    if (!highlightedColumnRule) {
      const sheet = document.querySelector('style[nonce]').sheet;
      const index = sheet.insertRule(':not(*) { background: var(--vscode-list-inactiveSelectionBackground); }', sheet.cssRules.length);
      highlightedColumnRule = sheet.cssRules[index];
    }
    const childIndex = cell.cellIndex + 1; // Includes the row-number header.
    highlightedColumnRule.selectorText = '#table-wrap #rows tr > td:nth-child(' + childIndex + '), ' +
      '#table-wrap thead tr > th:nth-child(' + childIndex + ')';
  }

  /**
   * Typing only highlights what is already on screen. Reading the whole file is
   * what Enter is for: a half-typed word would otherwise send the reader off to
   * a match for a query they had not finished.
   */
  function scheduleSearch() {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      // The results on screen belong to the query that produced them.
      if (byId('filter').value.trim() !== fileSearchQuery) discardFileMatches();
      runSearch();
    }, filterDelayMs);
  }

  function discardFileMatches() {
    fileMatches = [];
    fileMatchIndex = -1;
    fileSearchQuery = '';
    fileSearchDone = false;
    fileSearchTruncated = false;
    fileScannedRows = 0;
    pendingMatchFocus = null;
    following = false;
  }

  /**
   * Show how far the host has read while it reads. The file is counted and its
   * pages located before any of it is browsable: until then the scrollbar spans
   * a window rather than the file, and a drag lands nowhere in particular.
   * A file that cannot be indexed is shown anyway, bounded to its window.
   */
  function showPreparing(message) {
    const ready = Boolean(message.complete) || Boolean(message.failed);
    preparing = !ready;
    byId('preparing').hidden = ready;
    byId('filter').disabled = preparing;
    if (!preparing) return;
    const percent = indexSize > 0 ? Math.min(99, Math.floor((indexedBytes / indexSize) * 100)) : 0;
    byId('preparing-fill').style.width = percent + '%';
    byId('preparing-percent').textContent = percent + '%';
  }

  function requestNextPage() {
    if (loading || pageRequested || reachedEnd || !lastPageNumber) return;
    pageRequested = true;
    vscode.postMessage({ type: 'nextPage', afterPage: lastPageNumber });
  }

  /**
   * One request is in flight at a time, so a fast drag can outrun it and land
   * somewhere the answer does not cover. Once it arrives, fetch where the
   * reader actually ended up.
   */
  function reconcileWindow() {
    if (preparing || !absoluteScrolling() || loading || pageRequested) return;
    const rows = byId('rows').rows;
    if (!rows.length) return;
    const wanted = rowAtViewportTop();
    const firstRow = Number(rows[0].dataset.rowNumber);
    const lastRow = Number(rows[rows.length - 1].dataset.rowNumber);
    if (wanted >= firstRow && wanted <= lastRow) return;
    // The answer to that row is already in: asking again would only produce the
    // same window. Wait for the reader to move rather than loop.
    if (wanted === lastRequestedRow) return;
    requestRow(wanted);
  }

  /** Load whichever page holds a row, however far away it is. */
  function requestRow(row) {
    if (loading || pageRequested) return;
    pageRequested = true;
    lastRequestedRow = row;
    vscode.postMessage({ type: 'gotoRow', row: row });
  }

  function requestPreviousPage() {
    if (loading || pageRequested || firstPageNumber <= 1) return;
    pageRequested = true;
    vscode.postMessage({ type: 'previousPage', beforePage: firstPageNumber });
  }

  /** Load the window the reader stopped at. Called once a scroll gesture has
   *  settled, never while it is still running. */
  function maybeLoadAdjacentPage() {
    if (preparing) return;
    const tableWrap = byId('table-wrap');

    if (absoluteScrolling()) {
      const rows = byId('rows').rows;
      const wanted = rowAtViewportTop();
      if (!rows.length) { requestRow(wanted); return; }
      const firstRow = Number(rows[0].dataset.rowNumber);
      const lastRow = Number(rows[rows.length - 1].dataset.rowNumber);
      // Dragged clean out of the loaded window: fetch where they actually are.
      if (wanted < firstRow || wanted > lastRow) { requestRow(wanted); return; }
      const visible = Math.ceil(tableWrap.clientHeight / rowHeight);
      if (wanted + visible + prefetchRows > lastRow) requestNextPage();
      else if (wanted - prefetchRows < firstRow) requestPreviousPage();
      return;
    }

    const remaining = tableWrap.scrollHeight - tableWrap.scrollTop - tableWrap.clientHeight;
    if (scrollingUp && tableWrap.scrollTop <= autoloadDistance) requestPreviousPage();
    else if (!scrollingUp && remaining <= autoloadDistance) requestNextPage();
  }

  function scheduleMaybeLoadMore() {
    const tableWrap = byId('table-wrap');
    // A scroll event caused by render's compensation is not another user scroll.
    if (tableWrap.scrollTop === lastScrollTop) return;
    scrollingUp = tableWrap.scrollTop < lastScrollTop;
    lastScrollTop = tableWrap.scrollTop;
    // Scrolling is the reader taking over from a scan that was following along.
    stopFollowing();
    lastRequestedRow = -1;
    // Where they end up is what they asked to read, so wait for the scrollbar
    // to stop before loading anything.
    clearTimeout(scrollSettleTimer);
    scrollSettleTimer = setTimeout(() => {
      scrollSettleTimer = 0;
      maybeLoadAdjacentPage();
    }, scrollSettleMs);
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
      // A page the scan is sweeping past is only shown while still following.
      if (message.follow && !following) return;
      byId('error').style.display = 'none';
      render(message);
    } else if (message.type === 'loading') {
      loading = message.loading;
      if (!loading) pageRequested = false;
      byId('edit').disabled = message.loading;
      if (message.loading) byId('status').textContent = 'Loading…';
      // A gesture still in progress will ask for its own window when it stops;
      // reconciling now would load one the reader is already past.
      if (!loading && !scrollSettleTimer) reconcileWindow();
    } else if (message.type === 'fileIndex') {
      indexedBytes = message.indexedBytes || 0;
      indexSize = message.size || 0;
      indexComplete = Boolean(message.complete);
      if (message.complete) totalRows = message.totalRows || 0;
      showPreparing(message);
      rowHeight = measureRowHeight();
      updateSpacers();
      const rows = byId('rows').rows;
      if (rows.length) {
        byId('status').textContent = 'Rows ' + rows[0].dataset.rowNumber + '–' +
          rows[rows.length - 1].dataset.rowNumber + rowTotalLabel() +
          (reachedEnd ? ' · End' : '');
      }
    } else if (message.type === 'searchStarted') {
      // A scan for an older query may still be reporting; ignore it from here.
      if (message.query === fileSearchQuery) updateMatchCount();
    } else if (message.type === 'searchMatches') {
      if (message.query !== fileSearchQuery) return;
      const hadNone = fileMatches.length === 0;
      for (const match of message.matches) fileMatches.push(match);
      fileScannedRows = message.scannedRows;
      fileSearchTruncated = message.truncated;
      fileSearchDone = message.done;
      if (message.done) stopFollowing();
      if (hadNone && fileMatches.length) {
        // The first result the scan reaches from where the reader is.
        fileMatchIndex = 0;
        revealCurrentMatch(fileSearchReveals);
      } else {
        updateMatchCount();
      }
    } else if (message.type === 'error') {
      byId('error').textContent = message.message;
      byId('error').style.display = 'block';
    }
  });

  byId('filter').addEventListener('input', scheduleSearch);
  byId('filter').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      clearTimeout(filterTimer);
      const query = byId('filter').value.trim();
      if (!query) return;
      // The first Enter reads the file; later ones walk the results it found.
      if (query !== fileSearchQuery) {
        runSearch();
        requestFileSearch(true);
      } else {
        stepMatch(event.shiftKey ? -1 : 1);
      }
    } else if (event.key === 'Escape') {
      clearTimeout(filterTimer);
      byId('filter').value = '';
      requestFileSearch(false);
      runSearch();
      byId('filter').blur();
    }
  });
  document.querySelector('thead').addEventListener('click', event => {
    const column = event.target.closest('th[data-column-index]');
    if (column) selectSearchColumn(Number(column.dataset.columnIndex));
  });
  byId('rows').addEventListener('click', event => {
    const number = event.target.closest('th.row-number');
    if (number) highlightRow(number.parentElement);
    else {
      const cell = event.target.closest('td');
      if (cell) highlightCell(cell);
    }
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
  PAGE_CACHE_MAX_BYTES,
  PAGE_CACHE_MAX_PAGES,
  SEARCH_MATCH_LIMIT,
  searchLargeFile,
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
