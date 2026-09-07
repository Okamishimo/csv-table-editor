# Large files and the read-only preview

How the extension behaves when a file is too large to hold in an editable grid. Back to the [readme](../readme.md).

The editable grid is an in-memory editor. Local files larger than 64 MiB open in a streaming, read-only preview instead. Scrolling near either end loads the adjacent 100 rows, so you can move forward and backward without keeping the complete file in memory. The visible table stays bounded to 500 rows and lets you change the detected encoding.

The preview reads the whole file before you browse it. A progress bar reports that read; while it runs the table is covered and search is unavailable, because the length of the file, and therefore the meaning of the scrollbar, is not yet known. Choosing another encoding reads the file again. A file that cannot be read through is still previewed, with the scrollbar bounded to the loaded window.

Once the read has finished the scrollbar spans the whole file: everything outside the loaded window is shown as placeholder space, so the thumb tells you how far from the end you are. Dragging it anywhere loads that part of the file directly, and the status line reads `Rows 4,902–5,401 of 12,480,913`.

Cells containing line breaks show one and a half lines by default. Double-click a cell to expand its preview text, and double-click again to collapse it. Expansion lasts while the row remains in the loaded window; the existing preview text limits still apply. Collapsed rows reserve the same height so the unloaded parts of the file can be positioned accurately.

Rows are loaded for where you stop, not for everywhere you passed: a wheel or trackpad gesture, and a scrollbar drag, load one window once the scroller has come to rest. Landing somewhere new brings 200 rows at once, and if the screen is taller than that the preview keeps reading downward until it is filled, so a fast scroll never leaves you looking at a few rows above blank space.

Typing highlights the rows already loaded. Press **Enter** to search downward from the first visible row, continuing beyond the loaded window and stopping at the first matching cell; the preview loads that part of the file and jumps to it. Enter again reads on for the next match below, and **Shift+Enter** walks back through the ones already found. The search never wraps to the top of the file: at the end it says so and stays there. Clicking a column header limits the search to that column. Loading adjacent pages keeps the visible record at the same screen position, including when older rows leave the window or a search is active.

For files no larger than 511 MiB, **Enable Editing** can explicitly reopen the full in-memory grid after a warning. Files above that JavaScript hard limit, including multi-gigabyte CSV files, remain in the streaming preview. Adjust the automatic preview threshold with `csvTableEditor.maxFileSizeMB`.
