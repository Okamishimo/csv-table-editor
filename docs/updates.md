# Automatic updates

Where updates come from, how to install on each computer, and what the updater does on its own. Back to the [readme](../readme.md).

Stable updates come exclusively from public [`Okamishimo/csv-table-editor` GitHub Releases](https://github.com/Okamishimo/csv-table-editor/releases). No GitHub account, token, or sign-in is required. This extension is packaged as a VSIX and is never published to the public Marketplace. The extension ID is `Okamishimo.csv-table-editor`, separate from the upstream Marketplace extension `Edgar-Dang.csv-table-editor`. VS Code identifies extensions by publisher and name, so this build no longer shares the original extension's Marketplace listing or update identity.

## First installation on each computer

1. Download the latest stable release's `csv-table-editor-<version>-enhanced.vsix` from the Releases page.
2. In VS Code, run **Extensions: Install from VSIX…**, select the file, and reload VS Code. The updater supports installed desktop extensions on macOS and Windows. It does not update Remote SSH, WSL, container, web, or Extension Development Host installations.
3. Run **CSV Table Editor: Check for Extension Updates** to check now. If you use a named VS Code profile, first set `csvTableEditor.updates.profileName` to its exact name in User Settings. Default profiles need no extra setting. No `code` PATH setup is required.

## Moving from the original extension ID

Earlier builds of this adaptation, including 0.0.22, used `Edgar-Dang.csv-table-editor`. VS Code treated them as the original Marketplace extension. Starting with 0.0.23, this adaptation uses `Okamishimo.csv-table-editor` instead.

1. Save any open CSV edits. In Extensions, disable `Edgar-Dang.csv-table-editor` in each profile where it is installed. Keeping both enabled would register the same editor and commands twice.
2. Install 0.0.23 or later through **Extensions: Install from VSIX…** and reload the window. This is a one-time manual installation: the old updater correctly rejects the new publisher, and this VSIX does not replace or uninstall the old extension.
3. Check the installed extension's ID is `Okamishimo.csv-table-editor`. Future updates use this identity and the same GitHub Releases source.

The `csvTableEditor.*` settings and command IDs stay the same. Saved CSV files are unaffected. VS Code gives the new extension its own storage, so saved history, update timing, and legacy credentials are not automatically transferred.

To retain save history, close all VS Code windows and back up the old extension's storage first. Copy only its `history` subfolder from the active profile's `globalStorage/edgar-dang.csv-table-editor/` to `globalStorage/okamishimo.csv-table-editor/`, keeping the old copy. Do this before saving files with the new extension. If the new `history` folder already exists, back up both and do not overwrite it; choose which history to retain. Do not copy `private-updates`, lock files, or VS Code state databases. After confirming the new installation and any history you need, the disabled old extension can be uninstalled.

## Legacy update authentication

Public updates require no authentication. In 0.0.22, **CSV Table Editor: Clear Saved Update Authentication** removes that extension's stored token before it is disabled. A command running under the new ID cannot clear another extension's SecretStorage. The command retains `csvTableEditor.configureUpdateAuthentication` for existing keybindings; clearing credentials does not disable updates or sign other extensions out of GitHub.

## Update behavior and settings

- `csvTableEditor.updates.enabled` defaults to `true`. Disable it to stop automatic checks; the manual command still works.
- `csvTableEditor.updates.checkIntervalHours` defaults to `6` (range 1–168). The startup check waits 30 seconds; a lightweight timer checks whether an API request is due every five minutes. Attempt times persist across restarts, and failed requests also observe the interval. Manual checks bypass this interval but honor GitHub's rate-limit retry delay.
- Both automatic and manual checks use unauthenticated requests. Draft/prerelease releases and versions no newer than the installed package are skipped.
- A new stable version is downloaded automatically with its SHA-256 file. Downloads are streamed, limited to 128 MiB, and time out after two minutes per request. The updater verifies the checksum, package identity, and exact version before calling this running VS Code installation's CLI with `--install-extension <vsix> --force`. It uses separate process arguments on both platforms and targets the current user-data and extension directories.
- After installation, **Reload Window** activates the new version; **Later** keeps the current window running. Other open windows need their own reload. A local lock prevents concurrent installs across windows sharing the same profile, and successful installation state prevents repeated downloads.
- Failures are isolated from CSV editing and logged to **Output → CSV Table Editor Updates**. Manual failures also show a message. Installation failures include the CLI error output and exit code or termination signal when available, so compatibility and permission errors can be diagnosed. Credentials and URLs are redacted, and long diagnostics are truncated. Missing releases, unfinished release assets, a repository that is still private, and network errors can be retried with the manual command after the underlying problem is fixed.

Public release metadata and assets support [unauthenticated API access](https://docs.github.com/en/rest/releases/assets#get-a-release-asset). GitHub applies a [lower rate limit to unauthenticated requests](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), shared by clients using the same public IP. If it is reached, the updater waits for the retry delay, including for manual checks.
