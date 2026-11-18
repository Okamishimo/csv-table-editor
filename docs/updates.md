# Automatic updates

Where updates come from, how to install on each computer, and what the updater does on its own. Back to the [readme](../readme.md).

Stable updates come exclusively from public [`Okamishimo/csv-table-editor` GitHub Releases](https://github.com/Okamishimo/csv-table-editor/releases). No GitHub account, token, or sign-in is required. This extension is packaged as a VSIX and is never published to the public Marketplace. The extension ID is `Okamishimo.csv-table-editor`, separate from the upstream Marketplace extension `Edgar-Dang.csv-table-editor`. VS Code identifies extensions by publisher and name, so this build no longer shares the original extension's Marketplace listing or update identity.

## First installation on each computer

1. Download the latest stable release's `csv-table-editor-<version>-enhanced.vsix` from the Releases page.
2. In VS Code, run **Extensions: Install from VSIX…**, select the file, and reload VS Code. The updater supports installed desktop extensions on macOS and Windows. It does not update Remote SSH, WSL, container, web, or Extension Development Host installations.
3. Run **CSV Table Editor: Check for Extension Updates** to check now. Updates use the current VS Code profile, including named profiles, without extra configuration. No `code` PATH setup is required.

## Update behavior and settings

- `csvTableEditor.updates.enabled` defaults to `true`. Disable it to stop automatic checks; the manual command still works.
- `csvTableEditor.updates.checkIntervalHours` defaults to `6` (range 1–168). The startup check waits 30 seconds; a lightweight timer checks whether an API request is due every five minutes. Attempt times persist across restarts, and failed requests also observe the interval. Manual checks bypass this interval but honor GitHub's rate-limit retry delay.
- The former `csvTableEditor.updates.profileName` setting is no longer used and can be removed from `settings.json`. VS Code handles the current profile itself.
- Both automatic and manual checks use unauthenticated requests. Draft/prerelease releases and versions no newer than the installed package are skipped.
- A new stable version is downloaded automatically with its SHA-256 file. Downloads are streamed, limited to 128 MiB, and time out after two minutes per request. The updater verifies the checksum, package identity, and exact version before passing the local VSIX URI to VS Code's documented [`workbench.extensions.installExtension` command](https://code.visualstudio.com/api/references/commands#commands). On both macOS and Windows, VS Code handles installation in the current profile using its own extension management service. The updater waits for the command to complete before recording success or deleting the download. It does not locate an executable or launch a CLI process.
- After installation, **Reload Window** activates the new version; **Later** keeps the current window running. Other open windows need their own reload. A local lock prevents concurrent installs across windows sharing the same profile, and successful installation state prevents repeated downloads.
- Failures are isolated from CSV editing and logged to **Output → CSV Table Editor Updates**. Manual failures also show a message. Installation failures include the command's error message and error code when available, so compatibility, cancellation and permission errors can be diagnosed. Credentials and URLs are redacted, and long diagnostics are truncated. Failed or cancelled installations do not mark the update as installed. Missing releases, unfinished release assets, a repository that is still private, and network errors can be retried with the manual command after the underlying problem is fixed.

If an older build fails on Windows with `ENOENT` for a path such as `Microsoft VS Code\<commit>\Code.exe`, install a release containing the built-in installation command fix once through **Extensions: Install from VSIX…** and reload VS Code. That build calculated the executable path inside the resource version directory instead of the installation root.

Public release metadata and assets support [unauthenticated API access](https://docs.github.com/en/rest/releases/assets#get-a-release-asset). GitHub applies a [lower rate limit to unauthenticated requests](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), shared by clients using the same public IP. If it is reached, the updater waits for the retry delay, including for manual checks.
