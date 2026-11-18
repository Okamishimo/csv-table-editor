# Updates

[Back to readme](../readme.md)

Updates come from [GitHub Releases](https://github.com/Okamishimo/csv-table-editor/releases), without an account or token. The extension ID is `Okamishimo.csv-table-editor`; it is not distributed through the Marketplace.

## Install and update

1. Download the release's `csv-table-editor-<version>-enhanced.vsix`.
2. Run **Extensions: Install from VSIX…**, select it and reload VS Code.
3. Use **CSV Table Editor: Check for Extension Updates** to check manually.

Automatic installation supports local desktop extensions on **macOS and Windows**, using the current VS Code profile. Remote SSH, WSL, containers, web and development-host installations are excluded.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `csvTableEditor.updates.enabled` | `true` | Enable automatic checks; manual checks remain available. |
| `csvTableEditor.updates.checkIntervalHours` | `6` | Check interval, from 1 to 168 hours. |

The startup check waits 30 seconds. Failed checks respect the interval; manual checks bypass it but still honor GitHub's rate limits.

Downloads are verified before installation. Choose **Reload Window** to activate an update or **Later** to continue working. Failures leave the current editor usable; details appear in **Output → CSV Table Editor Updates**.

If an old build cannot update, including Windows `ENOENT` errors, install the latest VSIX manually once and reload.
