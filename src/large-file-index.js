"use strict";

/**
 * Row count and page offsets for a large CSV.
 *
 * The preview keeps a rolling window of rows, so without knowing how many rows
 * the file has, its scrollbar can only describe the window: the thumb never
 * changes size and never tells the reader how far from the end they are.
 * Random access has the same problem from the other side, because the pager
 * streams forward and cannot skip to a page it has not read.
 *
 * One pass over the file answers both. It counts records exactly, using the
 * same quote and terminator rules as `StreamingCsvParser` so the numbers agree
 * with the rows the preview shows, and records the byte offset where every page
 * begins. The offsets make any page directly reachable; the count makes the
 * scrollbar mean something.
 *
 * The scan reads bytes rather than decoded text, so an offset is always a real
 * file position. That is safe because the structural characters are ASCII and
 * none of the supported multi-byte encodings can produce those byte values in a
 * trailing byte. UTF-16 is the exception and is read as 16-bit units.
 */

const fs = require("node:fs");

const INDEX_CHUNK_BYTES = 1024 * 1024;
/** Bytes between event-loop yields, so indexing cannot stall the host. */
const INDEX_YIELD_BYTES = 8 * 1024 * 1024;

const QUOTE = 0x22;
const CARRIAGE_RETURN = 0x0d;
const LINE_FEED = 0x0a;

/** How a file's bytes carry the structural characters. */
function readerFor(encodingKey) {
  const key = String(encodingKey || "").replace(/-bom$/, "");
  if (key === "utf16le") return { step: 2, unit: (buffer, index) => buffer.readUInt16LE(index) };
  if (key === "utf16be") return { step: 2, unit: (buffer, index) => buffer.readUInt16BE(index) };
  return { step: 1, unit: (buffer, index) => buffer[index] };
}

/**
 * Where each page starts, and how many data rows the file holds.
 *
 * Offsets are stored per page: `pageOffset(n)` is the byte position of the
 * first record of page n. Page 1 starts after the header record, because the
 * preview shows the header separately from the rows it pages through.
 */
class CsvFileIndex {
  constructor(pageRows) {
    this.pageRows = pageRows;
    this.pageOffsets = [];
    this.totalRows = 0;
    this.complete = false;
  }

  get pageCount() {
    return this.pageOffsets.length;
  }

  hasPage(pageNumber) {
    return Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= this.pageOffsets.length;
  }

  pageOffset(pageNumber) {
    return this.hasPage(pageNumber) ? this.pageOffsets[pageNumber - 1] : null;
  }

  /** The page holding a display row number, or null when it is out of range. */
  pageForRow(rowNumber) {
    const dataRow = Number(rowNumber) - 2;
    if (!Number.isFinite(dataRow) || dataRow < 0) return null;
    // While the pass is still running the total is not yet known, so only a
    // finished index can say a row lies past the end.
    if (this.complete && dataRow >= this.totalRows) return null;
    return Math.floor(dataRow / this.pageRows) + 1;
  }
}

/**
 * Count the records of a CSV and note where each page begins.
 *
 * `hooks.cancelled()` stops the pass, `hooks.progress()` is called with the
 * bytes read so far, and the resolved index is marked complete only when the
 * whole file was read.
 */
async function buildFileIndex(filePath, encodingKey, pageRows, hooks = {}) {
  const index = new CsvFileIndex(pageRows);
  const { step, unit } = readerFor(encodingKey);
  const cancelled = hooks.cancelled || (() => false);
  const progress = hooks.progress || (() => {});

  const stream = fs.createReadStream(filePath, { highWaterMark: INDEX_CHUNK_BYTES });
  let offset = 0;
  let bytesSinceYield = 0;
  // Mirrors StreamingCsvParser: a record ends at CR or LF outside quotes, CRLF
  // counts once, and a trailing record only exists when something followed the
  // last terminator.
  let inQuotes = false;
  let afterQuote = false;
  let skipLineFeed = false;
  let pending = false;
  /** Records seen so far, header included. */
  let records = 0;
  let leftover = null;

  const startRecord = (position) => {
    // Record 0 is the header; page n begins at record (n - 1) * pageRows + 1.
    if (records === 0) return;
    const withinPage = (records - 1) % pageRows;
    if (withinPage === 0) index.pageOffsets.push(position);
  };

  try {
    for await (const chunk of stream) {
      if (cancelled()) return index;
      let buffer = chunk;
      if (leftover) {
        buffer = Buffer.concat([leftover, chunk]);
        offset -= leftover.length;
        leftover = null;
      }
      const limit = buffer.length - (buffer.length % step);
      if (limit < buffer.length) leftover = buffer.subarray(limit);

      for (let position = 0; position < limit; position += step) {
        const value = unit(buffer, position);
        if (skipLineFeed) {
          skipLineFeed = false;
          if (value === LINE_FEED) {
            startRecord(offset + position + step);
            continue;
          }
        }

        if (inQuotes) {
          if (afterQuote) {
            afterQuote = false;
            if (value === QUOTE) { pending = true; continue; }
            inQuotes = false;
            // Fall through and read this unit outside the quotes.
          } else if (value === QUOTE) {
            afterQuote = true;
            continue;
          } else {
            pending = true;
            continue;
          }
        }

        if (value === QUOTE) {
          inQuotes = true;
          pending = true;
        } else if (value === CARRIAGE_RETURN) {
          records++;
          pending = false;
          skipLineFeed = true;
          startRecord(offset + position + step);
        } else if (value === LINE_FEED) {
          records++;
          pending = false;
          startRecord(offset + position + step);
        } else {
          pending = true;
        }
      }

      offset += limit;
      bytesSinceYield += limit;
      progress(offset);
      if (bytesSinceYield >= INDEX_YIELD_BYTES) {
        bytesSinceYield = 0;
        await new Promise((resolve) => setImmediate(resolve));
        if (cancelled()) return index;
      }
    }
  } finally {
    stream.destroy();
  }

  if (cancelled()) return index;
  // A file not ending in a terminator still holds that last record.
  if (pending || afterQuote) records++;

  index.totalRows = Math.max(0, records - 1);
  index.complete = true;
  // The last record boundary marks where the next page would start. When the
  // file ends there, that page has no rows, so drop the offsets past the end.
  index.pageOffsets.length = Math.min(
    index.pageOffsets.length,
    Math.ceil(index.totalRows / pageRows)
  );
  return index;
}

module.exports = {
  CsvFileIndex,
  INDEX_CHUNK_BYTES,
  INDEX_YIELD_BYTES,
  buildFileIndex,
};
