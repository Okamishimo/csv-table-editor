# Change Log

All notable changes to the **CSV Table Editor — Encoding & History** extension
are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.13] - 2026-09-05

### Added

- The large-file preview searches the whole file instead of only the rows it has
  loaded. The host streams the file and reports matches as it finds them,
  beginning at the row on screen and wrapping at the end, so results appear while
  the rest is still being read. Enter and Shift+Enter move between matches
  anywhere in the file, loading the page that holds one when it is outside the
  current window, and the counter reports progress while the scan runs.
- The preview counts the file's rows in the background and shows the rest of the
  file as placeholder space, so the scrollbar spans the whole file instead of the
  few hundred loaded rows. The thumb says how much is left, the status line reads
  `Rows 4,902-5,401 of 12,480,913`, and dragging the scrollbar anywhere loads that
  part of the file directly rather than paging towards it.
- While a whole-file search runs, the preview follows the scan so you can see how
  far it has reached. It hands control back as soon as you scroll, a match is
  found, or the scan finishes.

### Fixed

- Saving no longer truncates the file when the grid is slow to answer. The save
  used to give up after five seconds and write an empty grid, which serializes to
  an empty file; the same happened when the panel could not be found. A save now
  waits as long as it needs, and fails without touching the file if the grid
  cannot be read. A save that takes longer than a moment reports itself in the
  status bar.
- Read-only paging preserves the visible row's actual screen position when
  inserting or removing cached pages, including short final pages. Loading no
  longer scrolls back to a search match or requests another page by itself.
- Scrolling back further than the page cache reaches reads the page again
  instead of stopping.

### Changed

- The editable grid renders only the rows near the viewport instead of building a
  DOM for the whole file. A 14 MiB CSV used to produce a 194 MiB HTML string and
  about 3.6 million elements on every open, sort and structural edit; it now holds
  a few dozen rows at a time, with spacer rows preserving the scrollbar. Search
  still counts every match but paints only the rows on screen, and stepping to a
  match scrolls to it. Column widths are measured once and pinned so scrolling
  cannot resize the table, and an edit in progress is committed before its row can
  be swapped out.
- Undo and redo carry the change instead of two copies of the whole grid. Editing
  one cell of a 14 MiB CSV took about 180 ms and permanently retained 3.2 million
  strings in the undo stack; it now takes well under a millisecond and retains two
  values. Deleting a row carries that row, deleting a column carries that column,
  and only a history rollback still travels whole.
- Encoding detection reads the file in place instead of copying it twice, and
  scans for ASCII by index rather than through the iterator protocol. Detecting a
  64 MiB ASCII CSV takes about 55 ms instead of about 370 ms and allocates no
  duplicate buffers. Detection results are unchanged: ASCII and strict UTF-8
  validation still read every byte.
- The preview's page cache is bounded and held in memory instead of growing
  without limit in a temporary file. Searching a 22 MiB CSV used to leave about
  31 MiB of JSON in the temporary directory, and a host crash left it behind; the
  cache now holds at most 8 MiB, and a page it has dropped is read again from its
  offset in about a millisecond.

## [0.0.12] - 2026-09-05

### Fixed

- Clicking a cell in the read-only preview cancels the previous whole-column
  selection and restores whole-window search, preventing two columns from
  remaining highlighted. The view stays at the clicked cell.

## [0.0.11] - 2026-09-05

### Fixed

- Release automation now finds draft releases by their pending tag before
  uploading or publishing, preventing the null `draft` error on a first release.
  Retrying after both assets uploaded publishes the existing draft and skips
  packaging without replacing either asset.

### Added

- Clicking a cell in the read-only preview highlights its row and column,
  including their headers, without changing search or loading more pages.
- Whole-row highlighting in the large-file preview through delegated row-number
  clicks, preserving the current search scope, results, and match position.

### Changed

- Editable column titles and sort arrows first select an unselected column.
  Sorting requires the whole column to already be selected and preserves that
  selection through ascending, descending, and original order.

## [0.0.10] - 2026-09-05

### Added

- Private GitHub Release updates on installed macOS and Windows extensions,
  with persistent six-hour checks, automatic verified VSIX installation,
  cross-window coordination, and a reload prompt.
- Commands to check updates immediately and configure a repository-scoped token
  in SecretStorage or use VS Code's managed GitHub authentication session.
- User settings for automatic updates, the check interval, and named profiles.
- A tag/release-triggered GitHub Actions workflow that builds the customized
  distribution, runs tests, packages a version-matched VSIX, and uploads it with
  SHA-256 to the private GitHub Release without overwriting older assets.

### Changed

- Added a supported `npm run build` task using distribution patches and syntax
  checks, preserving the original vendor bundle and editable-grid decorators.
- Prepared version 0.0.10 as the first manually installed updater-enabled build.

## [0.0.9] - 2026-09-05

### Added

- Search can be limited to one column by clicking its column header. Clicking
  that header again restores whole-table search. The editable grid and the
  loaded large-file preview both show the active scope and matching cells.

### Fixed

- Searching, sorting and clicking cells in the editable grid no longer scan
  the whole table for every match. Cells are reached through a row index
  rebuilt once per render, so a search that took over a minute on a few
  thousand rows now completes in milliseconds.
- Selecting a row or column paints a few stylesheet rules instead of adding a
  class to every cell in it, making cell selection cost the same on a large
  file as on a small one.
- Clicking a cell no longer re-runs the search; only an actual change of column
  scope does.
- Filter typing in the editable grid is debounced, so a long query runs one
  scan instead of one per keystroke.
- The grid's CSV parser copies runs of text between quotes, delimiters and
  line breaks rather than one character at a time, roughly quadrupling parse
  throughput.
- The large-file preview tracks its own highlighted cells instead of querying
  the loaded window, so stepping through matches and loading a page while a
  search is active no longer walk every visible cell.
- Evicting an off-window page from the preview collects the rows before
  detaching them, instead of re-reading the live row list after each removal.
- Preview cells get their tooltip on first hover rather than at render time,
  cutting about a third off the cost of loading a page.

### Changed

- Replaced the fixed font list with the free-form
  `csvTableEditor.fontFamily` setting. Any installed font or CSS fallback list
  can be entered, and open CSV editors update when the setting changes.
- Large-file previews now load cached pages in both scroll directions while
  keeping the in-memory DOM window bounded.
- Replaced the full-width read-only notice and the three paging/text buttons
  with a compact `Read-only preview` label in the toolbar.

## [0.0.8] - 2026-09-04

### Fixed

- Prevented filtered or short previews from chaining automatic page requests
  without another user scroll event.
- Reduced Webview and extension-host stalls with smaller stream batches,
  bounded row/cell previews, batched DOM insertion, debounced filtering and
  cooperative stream parsing.

### Added

- A persistent table-font selector for both the editable grid and the
  streaming large-file preview.

## [0.0.7] - 2026-09-04

### Changed

- The large-file preview now automatically streams the next 500 rows when the
  table is scrolled near the bottom. The **Load more** button remains as a
  manual fallback.
- The preview keeps a rolling window of at most 2,000 rows in the webview,
  removing the oldest rows as new ones arrive to keep memory use bounded.
- **First page** restarts the stream when earlier rows need to be viewed again.

## [0.0.6] - 2026-09-04

### Added

- A streaming, paged, read-only preview for local CSV/TSV files above the
  configured in-memory editing threshold.
- The preview reads 500 rows at a time, replaces the previous page, supports
  per-page filtering, encoding changes and returning to the first page.
- Files up to 511 MiB can explicitly opt into the original full-grid editing
  mode after a memory-use warning. Larger files remain safely read-only.
- Preview cells are capped at 20,000 characters and preview rows at 200
  columns to keep malformed data from exhausting the extension host.

### Changed

- `csvTableEditor.maxFileSizeMB` now selects when streaming preview starts,
  rather than rejecting larger local files.

## [0.0.5] - 2026-09-04

### Fixed

- Prevented oversized CSV/TSV files from reaching V8's single-string limit and
  crashing with `Cannot create a string longer than 0x1fffffe8 characters`.
- Oversized files now show their actual size and offer to reopen in VS Code's
  text editor.
- Added the `csvTableEditor.maxFileSizeMB` safety setting (64 MiB by default,
  capped at 511 MiB).

## [0.0.4] - 2026-09-04

### Added

- Automatic encoding detection for BOM-less UTF-16, Shift_JIS, EUC-JP, GBK,
  Big5, EUC-KR, Windows-1258, Windows-1252 and Latin-1 CSV/TSV files.
- Strict UTF-8 validation before falling back to a legacy encoding.
- Separate UTF-16 choices with and without a BOM, preserving the detected BOM
  behavior when the file is saved.

## [0.0.1] - Unreleased

### Added

- Open `.csv` and `.tsv` files in an editable grid (custom editor).
- Inline cell editing, add/remove rows and columns.
- Encoding support via `iconv-lite`: UTF-8, UTF-8 with BOM, UTF-16 LE/BE,
  Shift_JIS, EUC-JP, Windows-1252, Latin-1, GBK, Big5, EUC-KR, Windows-1258.
  Encoding is auto-detected from the BOM on open.
- Clickable encoding label in the toolbar to reopen with a different encoding
  or save with a chosen encoding.
- Ctrl/Cmd+F search across all cells, with match highlighting and navigation.
- Header-row detection with a metadata preamble kept above the table.
- Three-state column sort (ascending → descending → original) that is
  view-only and never reorders the underlying data on save.
- Excel-style row/column highlighting for the selected cell.
- Persistent per-file save history (last 50 versions) stored in the
  extension's global storage.
- Table diff view that compares a history version with the current content
  side by side, highlighting added, removed and changed rows.
