# CSV Table Editor — 編碼與儲存歷史

在 VS Code 裡把 `.csv` 與 `.tsv` 檔案當成可編輯的表格開啟，具備完整的**編碼**支援，以及可比對、可還原的**儲存歷史**。

英文版：[readme.md](../readme.md)。

> **這是個人改編版。** 本專案以 Edgar Dang 的 [CSV Table Editor](https://github.com/minlong8111/csv-table-editor) 為基礎，採 MIT 授權。原版擴充功能的執行檔原封不動沿用，此處新增的行為——大檔串流預覽、編碼偵測、儲存格層級的歷史比對、格線虛擬化、欄位範圍搜尋與自動更新器——則由本專案自己的模組接上去。本版本透過公開 GitHub Releases 以 VSIX 散布，相關問題請回報到本專案。

![CSV Table Editor 總覽](https://raw.githubusercontent.com/minlong8111/assets/main/csv-table-editor/screenshot-overview.png)

## 文件

這一頁說明這個擴充功能做什麼、怎麼用。篇幅較長的主題各自獨立成頁（內容為英文）：

- [大型檔案與唯讀預覽](large-files.md)：串流預覽、它的搜尋方式，以及決定一個檔案會用哪一種編輯器開啟的門檻。
- [自動更新](updates.md)：公開 GitHub Releases 與更新相關設定。
- [發布與儲存庫設定](releasing.md)：維護者用的資料——PR 的種類、發布流程與 GitHub 保護設定。
- [變更紀錄](../changelog.md)：每個版本改了什麼。

## 功能

### 以表格編輯

- 直接在 VS Code 裡以類試算表的格線開啟 CSV/TSV，不需要外部工具。
- 儲存格內編輯；可新增或刪除列與欄。
- 多行儲存格預設顯示一行半；雙擊儲存格展開，再次雙擊收合。唯讀預覽也支援此操作。
- 只有視窗附近的列會實際進入 DOM，所以長檔案的捲動、排序與搜尋不必為每一列建立元素。
- 支援標準的 `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` 完整復原／取消復原。

### 選擇編碼

先偵測帶 BOM 的檔案，接著檢查無 BOM 的 UTF-16、嚴格的 UTF-8，最後才是計分過的舊式編碼。你隨時可以透過工具列上可點擊的編碼標籤覆寫偵測結果，並以指定編碼重新開啟或儲存。

### 搜尋、排序與標題列

- `csvTableEditor.fontFamily` 可設定任何 CSS font-family 值，例如`"Microsoft JhengHei", "Noto Sans TC", sans-serif`。設定會同時套用到可編輯格線與大檔串流預覽。
- `Cmd/Ctrl+F` 搜尋所有儲存格，並提供符合項目的醒目提示與前後移動。點擊欄位標題可只搜尋該欄；要回到整表搜尋，再點一次同一個標題（編輯模式下請點標題背景，避開標題文字、排序箭頭與刪除按鈕）。
- 點擊列號可以在可編輯格線或大檔預覽中，將整列橫向記錄標示起來。預覽中的整列標示不會影響目前的搜尋範圍、結果與所在位置。
- 自動偵測標題列，並保留表格上方的前導說明列。
- 三段式欄位排序（遞增 → 遞減 → 原始順序）。排序**只影響檢視**，不會改變寫回磁碟的資料順序。編輯模式下，點擊尚未選取的欄位標題或排序箭頭會先選取該欄，之後的點擊才會排序，並在過程中保持該欄為選取狀態。
- 類似 Excel 的十字標示：選取的儲存格會標示它所在的列與欄，唯讀預覽中被點擊的儲存格也一樣。在預覽中點擊儲存格會取消先前的整欄選取、恢復對已載入所有列的搜尋，並只保留該儲存格的列與欄的標示。

### 儲存歷史與比對

- 每一次儲存都會記錄成一個版本（保留最近 50 個），存放在擴充功能的全域儲存空間，而不是在 CSV 旁邊留下一堆檔案。
- 從工具列開啟 **History** 面板瀏覽過去的版本。
- 以左右並排的**表格比對**檢視任一版本與目前內容的差異，標示出變更的儲存格、新增或刪除的列，以及新增或刪除的欄。開啟時會自動跳到第一個變更；用 **↑ / ↓** 或 **Shift+F7 / F7** 在變更的列之間移動。
- 可將某個版本還原成「未儲存的變更」，先檢查再決定要不要覆寫檔案。

![歷史版本與目前內容的並排表格比對](https://raw.githubusercontent.com/minlong8111/assets/main/csv-table-editor/screenshot-diff.png)

## 使用方式

1. 開啟任何 `.csv` 或 `.tsv` 檔案，預設就會以表格編輯器開啟。若檔案已經開著，用 **View: Reopen Editor With…** 選擇 **CSV Table Editor**。
2. 點擊儲存格即可編輯；用工具列按鈕新增列或欄。
3. 點擊工具列的編碼標籤，即可用其他編碼重新開啟或儲存。
4. 點擊 **History** 檢視、比對或還原到先前的儲存版本。
5. 按 `Cmd/Ctrl+S` 儲存。

## 系統需求

不需要額外設定。編碼轉換由內建的 [`iconv-lite`](https://www.npmjs.com/package/iconv-lite) 函式庫處理。

可編輯格線是記憶體內的編輯器。超過 64 MiB 的本機檔案會改以串流唯讀預覽開啟；預覽會先把整個檔案讀過一遍，之後就能捲動與搜尋整個檔案。預覽能做到什麼、不能做到什麼，請見[大型檔案](large-files.md)。

自動更新使用公開 GitHub Releases，不需要 Token 或登入。更新相關指令只保留 **CSV Table Editor: Check for Extension Updates**，請見[自動更新](updates.md)。

## 授權

[MIT](https://github.com/Okamishimo/csv-table-editor/blob/HEAD/LICENSE.txt)，與本專案所改編的擴充功能相同。`LICENSE.txt` 同時保留兩份聲明：原始作品的著作權屬於 Edgar Dang，本改編版所做的變更著作權屬於 Mete (Okamishimo)。
