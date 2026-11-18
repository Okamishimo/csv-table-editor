# Large files

[Back to readme](../readme.md)

Local files above `csvTableEditor.maxFileSizeMB` (default **64 MiB**) open in a read-only streaming preview.

- The initial scan shows progress and must finish before scrolling or searching. Changing encoding starts a new scan. If indexing fails, the preview remains available within the loaded window.
- Once scanned, the scrollbar covers the whole file. Drag to a position and pause to load it; the status line shows the target row while dragging.
- Typing highlights loaded rows. **Enter** searches downward through the file from the visible row; press again for the next match. **Shift+Enter** returns to previously found matches. Search does not wrap.
- A column header limits search to that column; row-number highlighting does not change the scope. Clicking a data cell clears a whole-column selection.
- Double-click a cell to expand or collapse its preview text.

## Limits

| Item | Limit |
| --- | --- |
| Loaded window | 500 rows |
| Displayed columns | 100 |
| Preview text | 4,096 characters per cell; 32,768 per row |
| Full editing | 511 MiB |

Preview limits do not modify the source file. **Enable Editing** can open files up to 511 MiB in memory after a warning; larger files remain read-only.
