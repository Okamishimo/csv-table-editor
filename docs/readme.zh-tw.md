# CSV Table Editor — 編碼與儲存歷史

在 VS Code 裡以表格編輯 CSV/TSV，支援編碼轉換、搜尋與儲存歷史。

[English](../readme.md) · 本專案為 [Edgar Dang 的 CSV Table Editor](https://github.com/minlong8111/csv-table-editor) 個人改編版，採 [MIT 授權](../LICENSE.txt)。

## 安裝

需要 **VS Code 1.146 或更新版本**。

1. 從 [GitHub Releases](https://github.com/Okamishimo/csv-table-editor/releases) 下載 `csv-table-editor-<version>-enhanced.vsix`。
2. 執行 **Extensions: Install from VSIX…**，選取檔案並重新載入 VS Code。

[自動更新](updates.md)支援 macOS 與 Windows 本機安裝。

## 使用方式

- 開啟 `.csv` 或 `.tsv`；若已用其他編輯器開啟，選擇 **Reopen Editor With… → CSV Table Editor**。
- 點擊儲存格編輯，以工具列新增或刪除列、欄。儲存與復原沿用 VS Code 快捷鍵。
- **Editable / Read-only** 可鎖定編輯，保留未儲存的修改與瀏覽功能。
- 點擊編碼標籤，以其他編碼重新開啟或儲存。可自動偵測 BOM、UTF-8、UTF-16 及常見舊式編碼。
- **Cmd/Ctrl+F** 搜尋整張表。點擊欄位標題可只搜尋該欄，再點同一標題的背景清除範圍。點擊列號會標示整列，不會限制搜尋範圍。
- 先選取整欄，再點標題文字或排序箭頭，依序切換遞增、遞減與原始順序。排序不影響儲存的列順序。
- 雙擊儲存格可展開或收合長文字。
- **History** 保留最近 50 次儲存，可比對變更的儲存格，或還原為未儲存的修改。比對時以 **Shift+F7 / F7** 在變更之間移動。

## 設定與限制

| 設定 | 用途 |
| --- | --- |
| `csvTableEditor.fontFamily` | 任意已安裝字型或 CSS font-family 清單。 |
| `csvTableEditor.maxFileSizeMB` | 可編輯格線的大小門檻，預設 64 MiB，硬上限 511 MiB。 |

更大的本機檔案會使用[串流唯讀預覽](large-files.md)。

[更新設定](updates.md) · [變更紀錄](../changelog.md) · [維護者發布指南](releasing.md)
