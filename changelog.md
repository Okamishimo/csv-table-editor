# Change Log

User-facing changes to CSV Table Editor — Encoding & History.

## [Unreleased]

## [0.0.25] - 2026-11-18

- Fix extension updates failing on Windows with `ENOENT`.
- Updates use the current VS Code profile on macOS and Windows; `csvTableEditor.updates.profileName` is no longer needed.
- Require VS Code 1.146 or later.

## [0.0.24] - 2026-11-12

- Add the **Editable / Read-only** switch while preserving unsaved edits.
- Keep data columns at 200 pixels and row numbers compact.
- Double-click long or multiline cells to expand/collapse text.
- Keep only **Check for Extension Updates** among update commands.

## [0.0.23] - 2026-09-12

- Use `Okamishimo.csv-table-editor` to separate this build from the original Marketplace extension.

## [0.0.22] - 2026-09-11

- Install public GitHub Release updates without a token or sign-in.
- Show installation failure details in the update log and manual-check warning.

## [0.0.21] - 2026-09-11

- Restore fast loading and searching of large-file previews.

## [0.0.20] - 2026-09-10

- Stabilize scrollbar dragging and make every row reachable in very large files.
- Show multiline cells at one and a half lines by default, with double-click expansion.

## [0.0.19] - 2026-09-06

- Fill the preview viewport after fast scrolling instead of leaving blank space.

## [0.0.18] - 2026-09-06

- Preserve every rapid save in history and align adjacent changes correctly in comparisons.
- Add previous/next-change navigation to history comparisons.
- Continue preview searches below the last match; **Shift+Enter** returns to earlier results.

## [0.0.17] - 2026-09-06

- Scan large files with progress before browsing and load rows after scrolling settles.

## [0.0.15] - 2026-09-06

- Start whole-file preview search with **Enter**, leaving typing to highlight visible rows.
- Highlight changed history cells and align inserted/removed columns.
- Fix repeated preview loading and keep large history comparisons responsive.

## [0.0.14] - 2026-09-05

- Keep scrollbar jumps at the requested row, including fast drags.

## [0.0.13] - 2026-09-05

- Add whole-file preview search and a scrollbar spanning the complete file.
- Prevent failed or slow saves from truncating files; show progress for slow saves.
- Preserve the visible position when paging in either direction.
- Reduce memory use for large editable grids, undo and preview caching.

## [0.0.12] - 2026-09-05

- Clear whole-column search scope when clicking a preview cell without moving the view.

## [0.0.11] - 2026-09-05

- Highlight a preview cell's row and column, and support whole-row selection.
- Preserve search scope when selecting a row.
- Require column selection before sorting in the editable grid.

## [0.0.10] - 2026-09-05

- Add GitHub Release updates for installed macOS and Windows extensions.

## [0.0.9] - 2026-09-05

- Add column-scoped search and free-form font settings.
- Improve grid search, selection and parsing performance.
- Support preview scrolling in both directions.

## [0.0.8] - 2026-09-04

- Prevent repeated preview loading and improve responsiveness.
- Add font selection to both editor modes.

## [0.0.7] - 2026-09-04

- Load further preview rows while scrolling with bounded memory use.

## [0.0.6] - 2026-09-04

- Add a streaming read-only preview for files above the editing threshold.
- Allow explicit full editing up to 511 MiB.

## [0.0.5] - 2026-09-04

- Protect against oversized-file crashes with a 64 MiB default editing threshold and 511 MiB hard limit.

## [0.0.4] - 2026-09-04

- Detect BOM-less UTF-16 and common legacy encodings, validate UTF-8, and preserve BOM choices.

## [0.0.1] - Initial build

- Add CSV/TSV grid editing, encoding selection, search, sorting and persistent save history.
