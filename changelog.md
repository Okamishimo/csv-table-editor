# Change Log

All notable changes to the **CSV Table Editor — Encoding & History** extension
are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Merging a pull request before its checks have finished no longer publishes
  anything. This repository's plan cannot require the checks server side, so the
  merge button stays available while `Verify` is still running; the merge
  workflow now reads the merged commit's own check runs and refuses to create a
  tag, package or release unless `PR policy` and `Verify` both completed
  successfully on it.

## [0.0.20] - 2026-09-10

### Fixed

- Dragging the read-only preview's scrollbar no longer sends the view leaping
  back and forth while you hold the thumb. A scrollbar over half a million rows
  moves several hundred rows for every pixel of pointer movement, so the tremor
  of a hand holding the thumb was loading a fresh window every fraction of a
  second. Loading now waits for the hand as well as the gesture, and the status
  line names the row the thumb is over while you are still dragging, so you can
  aim before letting go.
- The read-only preview's scrollbar measures the whole file however long it is.
  A browser will not lay out a scroller taller than about 33 million pixels —
  roughly a million rows — and past that the thumb measured the ceiling instead
  of the file: dragging it to the middle of a multi-million-row file landed a
  tenth of the way in, and the rest of the file could not be reached at all.
  Such a file now shares a scroller the browser can draw between the rows above
  and below the loaded window, and a jump puts the reader on the row the thumb
  pointed at. Rows in the loaded window keep their real height, so reading
  through the window is unchanged.

### Changed

- Multi-line cells show one and a half lines by default in the editable grid
  and large-file preview. Double-click toggles expansion without changing the
  cell's contents, and scrolling accounts for the expanded row heights.

## [0.0.19] - 2026-09-06

### Fixed

- Scrolling the read-only preview quickly and stopping no longer leaves most of
  the screen blank. A jump now arrives as 200 rows — the page holding the row
  the reader stopped at and the page below it — and a window that still ends
  above the bottom of the viewport reads on until the screen is covered.

### Changed

- Pull requests come in four kinds: `Docs:`, `Feature:`, `Fix:` and
  `Release vX.Y.Z:`. Feature and Fix work merges into main without a tag or a
  release, and a later release publishes what has accumulated. Only a release
  PR may change the version, and it must.
- A merged pull request's branch is deleted by the repository setting rather
  than by a workflow of ours.
- The readme is a page about the extension again: large files, private updates
  and the release workflow moved to a page each under `docs/`, which it links
  to, and a Traditional Chinese translation of it lives at
  `docs/readme.zh-tw.md`.
- The readme says plainly that this is a personal adaptation of Edgar Dang's
  CSV Table Editor, and `LICENSE.txt` now carries the copyright of this
  adaptation alongside the original author's, which the MIT license requires be
  kept. The readme's license link points at this repository's own license.

## [0.0.18] - 2026-09-06

### Fixed

- Rapid saves no longer overwrite each other's history index entries. Each
  version keeps the exact saved bytes, including edits in the focused cell.
- Adjacent changed rows in history comparisons align one for one, preserving
  cell-level highlights for multiple edits.
- Read-only preview searches begin at the first visible row and continue
  downward, stopping at the first match without restarting from the top. Enter
  reads on for the next match below and Shift+Enter walks back through the ones
  already found; previously a second Enter could never leave the first match.

### Added

- History comparisons jump to the first change and offer previous/next change
  buttons, a position counter, and Shift+F7/F7 keyboard navigation.
- Merging a pull request deletes its head branch automatically. A pull request
  closed without merging keeps its branch.

## [0.0.17] - 2026-09-06

### Changed

- The large-file preview loads a window when the scroller stops rather than
  while it is still moving, so a wheel gesture or a scrollbar drag fetches the
  place it ends at instead of every window it passes over.
- The preview reads the whole file, with a progress bar, before it can be
  scrolled or searched. The row count and page offsets are known before the
  first gesture, so the scrollbar measures the file from the start. A file that
  cannot be indexed is still previewed, bounded to the loaded window.

## [0.0.16] - 2026-09-06

### Added

- Documentation PRs titled `Docs: description` use quick file-scope and whitespace
  checks, require no version bump, and skip tagging and publication after merging.
  Code, configuration, and workflow changes under a Docs title fail validation.
- Shared release preflight skill for Codex and Claude Code, with a central
  contributor release policy and task-specific loading instructions.
- Local staged-content verification before commits, and push guards requiring
  PRs for main and tags to point to commits already on remote main.
- Release PR title/version checks and full verification in GitHub Actions.
  Merged release PRs automatically tag their merge commit and call the existing
  private publication workflow, which also checks tag ancestry.
- Prepared main and immutable-tag protection configurations for activation when
  the private repository's GitHub plan supports them.

## [0.0.15] - 2026-09-06

### Changed

- Searching the large-file preview starts when you press Enter rather than while
  you are still typing. Typing highlights the rows already on screen and says how
  many it found there; Enter reads the file, and Enter again walks the results. A
  half-typed word no longer sends you off to a match for it.
- The history diff highlights the cells that changed rather than the whole row.
  Rows that were added or removed are still highlighted whole, and a column that
  exists in only one of the two versions is highlighted whole as well. Columns
  are matched by name first, so inserting a column no longer makes every cell of
  every row look changed.

### Fixed

- Scrolling the preview quickly could leave it loading the same window over and
  over, flickering between a row count and "Loading…" while the scrollbar refused
  to settle. The preview now measures where a row actually sits instead of
  trusting its own arithmetic, and accepts a window that does not cover it rather
  than asking for it again.
- Comparing two large history versions could ask for a table of one cell per pair
  of rows. Identical leading and trailing rows are trimmed first, and what remains
  is compared by position when it is still too large.

## [0.0.14] - 2026-09-05

### Fixed

- Dragging the read-only preview's scrollbar out of the loaded window sent you
  back to the first row instead of leaving you where you dropped it. A drag fast
  enough to outrun the page being loaded could also leave you looking at empty
  placeholder space; the preview now fetches where you actually stopped.

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
