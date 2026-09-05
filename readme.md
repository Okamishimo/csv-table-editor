# CSV Table Editor — Encoding & History

Open, view and edit `.csv` and `.tsv` files as an editable grid inside VS Code,
with first-class **encoding** support and a persistent **save history** you can
diff and roll back to.

![CSV Table Editor overview](https://raw.githubusercontent.com/minlong8111/assets/main/csv-table-editor/screenshot-overview.png)

## Features

### Edit as a grid

- Opens CSV/TSV files in a spreadsheet-like grid — no external tools.
- Inline cell editing; add or remove rows and columns.
- Full undo/redo through the standard `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z`.

### Pick your encoding

Auto-detects BOM-marked files first, then checks BOM-less UTF-16, strict UTF-8
and a scored set of legacy encodings. You can always override the result and
reopen or save with any of these via the clickable encoding label:

- UTF-8, UTF-8 with BOM
- UTF-16 LE and UTF-16 BE, with or without a BOM
- Shift_JIS, EUC-JP
- Windows-1252, Latin-1 (ISO-8859-1)
- GBK, Big5, EUC-KR
- Windows-1258 (Vietnamese)

### Search, sort and headers

- Set `csvTableEditor.fontFamily` to any CSS font-family value. For example,
  `"Microsoft JhengHei", "Noto Sans TC", sans-serif`. Changes apply to both
  the editable grid and the streaming large-file preview.
- `Cmd/Ctrl+F` searches across every cell with match highlighting and navigation.
  Click a column header to search only that column; click the same header again
  to return to whole-table search.
- Automatic header-row detection, keeping any metadata preamble above the table.
- Three-state column sort (ascending → descending → original). Sorting is
  **view-only** — it never reorders the data written back to disk.
- Excel-style row and column highlighting for the selected cell.

### History and diff

- Every save is captured as a version (the last 50 are kept), stored in the
  extension's global storage — not as stray files next to your CSV.
- Open the **History** panel from the toolbar to browse past versions.
- Compare any version with the current content in a side-by-side **table diff**
  that highlights added, removed and changed rows.
- Roll back to a version as unsaved changes, so you review before overwriting.

![Side-by-side table diff between a history version and the current content](https://raw.githubusercontent.com/minlong8111/assets/main/csv-table-editor/screenshot-diff.png)

## Usage

1. Open any `.csv` or `.tsv` file — it opens in the grid editor by default.
   To switch an already-open file, use **View: Reopen Editor With…** and pick
   **CSV Table Editor**.
2. Click a cell to edit. Use the toolbar buttons to add rows/columns.
3. Click the encoding label in the toolbar to reopen or save with a different
   encoding.
4. Click **History** to view, diff, or roll back to a previous save.
5. Press `Cmd/Ctrl+S` to save.

## Requirements

No additional setup. Encoding conversion is handled by the bundled
[`iconv-lite`](https://www.npmjs.com/package/iconv-lite) library.

The editable grid is an in-memory editor. Local files larger than 64 MiB open
in a streaming, read-only preview instead. Scrolling near either end loads the
adjacent 100 rows, so you can move forward and backward without keeping the
complete file in memory. The visible table stays bounded to 500 rows, supports
searching the loaded window (including column-only search) and lets you change the
detected encoding.

For files no larger than 511 MiB, **Enable Editing** can explicitly reopen the
full in-memory grid after a warning. Files above that JavaScript hard limit,
including multi-gigabyte CSV files, remain in the streaming preview. Adjust
the automatic preview threshold with `csvTableEditor.maxFileSizeMB`.

## Known limitations

- Legacy encodings can be inherently ambiguous for very short files. Use the
  clickable encoding label to override a guess when needed.
- Sorting and header detection are heuristic; a header can be one row off on
  unusual files.
- The table diff compares serialized CSV text, so purely formatting-level
  differences (quoting style) may show as changes.
- History is keyed by file path — renaming or moving a file starts a fresh
  history.
- The editable grid renders every row at once. Search, sorting and cell
  selection stay fast on large tables, but opening a file with hundreds of
  thousands of rows is still slow because the whole table is built as DOM.
  Lower `csvTableEditor.maxFileSizeMB` to send such files to the streaming
  preview instead.

## License

[MIT](https://github.com/minlong8111/csv-table-editor/blob/HEAD/LICENSE)
