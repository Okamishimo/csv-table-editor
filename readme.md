# CSV Table Editor — Encoding & History

Open, view and edit `.csv` and `.tsv` files as an editable grid inside VS Code, with first-class **encoding** support and a persistent **save history** you can diff and roll back to.

> **This is a personal adaptation.** It builds on Edgar Dang's [CSV Table Editor](https://github.com/minlong8111/csv-table-editor), under the MIT license. The original extension runtime is included unchanged as a vendor artifact, and the behavior added here — the streaming large-file preview, the encoding detector, the cell-level history diff, grid virtualization, column-scoped search and the automatic updater — is wired into it by modules of this repository's own. This build is distributed as a VSIX through public GitHub Releases. Report issues in this repository.

![CSV Table Editor overview](https://raw.githubusercontent.com/minlong8111/assets/main/csv-table-editor/screenshot-overview.png)

**繁體中文說明：[docs/readme.zh-tw.md](docs/readme.zh-tw.md)**

## Documentation

This page covers what the extension does and how to use it. The longer subjects have pages of their own:

- [Large files and the read-only preview](docs/large-files.md) — the streaming preview, its search, and the limits that decide which editor a file opens in.
- [Automatic updates](docs/updates.md) — public GitHub Releases and the update settings.
- [Releasing and repository setup](docs/releasing.md) — maintainer material: PR kinds, the release workflow, and GitHub protection.
- [Change log](changelog.md) — what changed in each version.

## Features

### Edit as a grid

- Opens CSV/TSV files in a spreadsheet-like grid — no external tools.
- Inline cell editing; add or remove rows and columns.
- Multi-line cells show one and a half lines by default. Double-click a cell to expand it; double-click again to collapse it. This also works in the read-only preview.
- Only the rows near the viewport are rendered, so long files scroll, sort and search without the editor building a DOM for every row.
- Full undo/redo through the standard `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z`.

### Pick your encoding

Auto-detects BOM-marked files first, then checks BOM-less UTF-16, strict UTF-8 and a scored set of legacy encodings. You can always override the result and reopen or save with the encoding you choose, through the clickable encoding label.

### Search, sort and headers

- Set `csvTableEditor.fontFamily` to any CSS font-family value. For example, `"Microsoft JhengHei", "Noto Sans TC", sans-serif`. Changes apply to both the editable grid and the streaming large-file preview.
- `Cmd/Ctrl+F` searches across every cell with match highlighting and navigation. Click a column header to search only that column. To return to whole-table search, click the same header again; in editing mode, click its background outside the title, sort arrow, and delete button.
- Click a row number to highlight that whole horizontal record in either the editable grid or large-file preview. Row highlighting in the preview preserves the current search scope, results, and match position.
- Automatic header-row detection, keeping any metadata preamble above the table.
- Three-state column sort (ascending → descending → original). Sorting is **view-only** — it does not reorder the data written back to disk. In editing mode, clicking an unselected column's title or sort arrow selects it first; subsequent clicks sort it while keeping the column selected.
- Excel-style row and column highlighting for the selected cell, including clicked cells in the read-only preview. Preview cell clicks cancel any prior whole-column selection and restore search across all loaded rows, leaving only the clicked cell's row and column highlighted.

### History and diff

- Every save is captured as a version (the last 50 are kept), stored in the extension's global storage — not as stray files next to the CSV.
- Open the **History** panel from the toolbar to browse past versions.
- Compare any version with the current content in a side-by-side **table diff** that highlights changed cells, added or removed rows, and added or removed columns. It jumps to the first change automatically; use **↑ / ↓** or **Shift+F7 / F7** to move between changed rows.
- Roll back to a version as unsaved changes, to review before overwriting.

![Side-by-side table diff between a history version and the current content](https://raw.githubusercontent.com/minlong8111/assets/main/csv-table-editor/screenshot-diff.png)

## Usage

1. Open any `.csv` or `.tsv` file — it opens in the grid editor by default. To switch an already-open file, use **View: Reopen Editor With…** and pick **CSV Table Editor**.
2. Click a cell to edit. Use the toolbar buttons to add rows/columns.
3. Click the encoding label in the toolbar to reopen or save with a different encoding.
4. Click **History** to view, diff, or roll back to a previous save.
5. Press `Cmd/Ctrl+S` to save.

## Requirements

No additional setup. Encoding conversion is handled by the bundled [`iconv-lite`](https://www.npmjs.com/package/iconv-lite) library.

The editable grid is an in-memory editor. Local files larger than 64 MiB open in a streaming, read-only preview instead, which reads the whole file before you browse it and then lets you scroll and search all of it. See [large files](docs/large-files.md) for what that preview can and cannot do.

## License

[MIT](https://github.com/Okamishimo/csv-table-editor/blob/HEAD/LICENSE.txt), the same license as the extension this one adapts. `LICENSE.txt` carries both notices: the original work is copyright Edgar Dang, and the changes in this adaptation are copyright Mete (Okamishimo).
