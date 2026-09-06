# Private automatic updates

Where updates come from, how to authenticate on each computer, and what the updater does on its own. Back to the [readme](../readme.md).

Stable updates come exclusively from the private [`Okamishimo/csv-table-editor` GitHub Releases](https://github.com/Okamishimo/csv-table-editor/releases). This extension is packaged as a VSIX and is never published to the public Marketplace. The extension ID remains `Edgar-Dang.csv-table-editor` so existing installations are upgraded in place.

## First installation on each computer

1. Sign in to GitHub with access to the private repository and download `csv-table-editor-0.0.10-enhanced.vsix` (or a newer stable release). Versions up to 0.0.9 do not contain the updater, so they need this one manual upgrade.
2. In VS Code, run **Extensions: Install from VSIX…**, select the file, and reload VS Code. The updater supports installed desktop extensions on macOS and Windows. It does not update Remote SSH, WSL, container, web, or Extension Development Host installations.
3. Run **CSV Table Editor: Configure Private Update Authentication** and choose:
   - **Fine-grained GitHub token** (recommended for least privilege): create a token with resource owner `Okamishimo`, select **Only select repositories → csv-table-editor**, and grant **Contents: Read-only** (Metadata read access is implicit). Paste it into the password input. It is stored only in VS Code SecretStorage, not settings, files, Git, logs, or CLI arguments.
   - **Sign in with GitHub**: use VS Code's built-in authentication provider. VS Code manages the session; this extension does not store a copy. Private repository access requires the broader OAuth `repo` scope. Choose the fine-grained token if you want to limit access to this one repository.
4. Run **CSV Table Editor: Check for Extension Updates** to verify access. If you use a named VS Code profile, first set `csvTableEditor.updates.profileName` to its exact name in User Settings. Default profiles need no extra setting. No `code` PATH setup is required.

SecretStorage credentials do not sync between computers. Configure authentication once on each computer/profile; repeat it when a token expires or is revoked. Organization-managed repositories may require token approval or SSO authorization. **Disconnect private updates** deletes this extension's token and stops using its GitHub session; it does not sign other extensions out of GitHub.

## Update behavior and settings

- `csvTableEditor.updates.enabled` defaults to `true`. Disable it to stop automatic checks; the manual command still works.
- `csvTableEditor.updates.checkIntervalHours` defaults to `6` (range 1–168). The startup check waits 30 seconds; a lightweight timer checks whether an API request is due every five minutes. Attempt times persist across restarts, and failed requests also observe the interval. Manual checks bypass this interval but honor GitHub's rate-limit retry delay.
- Background checks never prompt for authentication. Configure it explicitly once using the command above. Draft/prerelease releases and versions no newer than the installed package are skipped.
- A new stable version is downloaded automatically with its SHA-256 file. Downloads are streamed, limited to 128 MiB, and time out after two minutes per request. The updater verifies the checksum, package identity, and exact version before calling this running VS Code installation's CLI with `--install-extension <vsix> --force`. It uses separate process arguments on both platforms and targets the current user-data and extension directories.
- After installation, **Reload Window** activates the new version; **Later** keeps the current window running. Other open windows need their own reload. A local lock prevents concurrent installs across windows sharing the same profile, and successful installation state prevents repeated downloads.
- Failures are isolated from CSV editing and logged to **Output → CSV Table Editor Updates**. Manual failures also show a message. Missing releases, unfinished release assets, expired credentials, and network errors can be retried with the manual command after the underlying problem is fixed.
