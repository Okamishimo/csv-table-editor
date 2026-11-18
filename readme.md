# CSV Table Editor — Encoding & History

Edit CSV/TSV files as a table in VS Code, with encoding conversion, search and save history.

[繁體中文](docs/readme.zh-tw.md) · Personal adaptation of [Edgar Dang's CSV Table Editor](https://github.com/minlong8111/csv-table-editor), under the [MIT license](LICENSE.txt).

## Install

Requires **VS Code 1.146 or later**.

1. Download `csv-table-editor-<version>-enhanced.vsix` from [GitHub Releases](https://github.com/Okamishimo/csv-table-editor/releases).
2. Run **Extensions: Install from VSIX…**, select the file and reload VS Code.

[Automatic updates](docs/updates.md) support local macOS and Windows installations.

## Use

- Open a `.csv` or `.tsv` file. To switch an existing editor, use **Reopen Editor With… → CSV Table Editor**.
- Click a cell to edit; use the toolbar to add/remove rows and columns. Save and undo use the usual VS Code shortcuts.
- **Editable / Read-only** locks editing while preserving unsaved changes and browsing.
- Click the encoding label to reopen or save with another encoding. BOM, UTF-8, UTF-16 and common legacy encodings are detected automatically.
- **Cmd/Ctrl+F** searches the table. Select a column header to search only that column; click its background again to clear the scope. Row-number clicks highlight rows without limiting search.
- Select a column, then click its title or sort arrow to cycle ascending, descending and original order. Sorting does not change the saved row order.
- Double-click a cell to expand or collapse long text.
- **History** keeps the last 50 saves, compares changed cells and restores a version as unsaved edits. **Shift+F7 / F7** moves between changes in the comparison.

## Settings and limits

| Setting | Purpose |
| --- | --- |
| `csvTableEditor.fontFamily` | Any installed font or CSS font-family list. |
| `csvTableEditor.maxFileSizeMB` | Editable-grid threshold; defaults to 64 MiB, with a 511 MiB hard limit. |

Larger local files use a [read-only streaming preview](docs/large-files.md).

[Update settings](docs/updates.md) · [Change log](changelog.md) · [Maintainer release guide](docs/releasing.md)
