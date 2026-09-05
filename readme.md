# CSV Table Editor — Encoding & History

Open, view and edit `.csv` and `.tsv` files as an editable grid inside VS Code,
with first-class **encoding** support and a persistent **save history** you can
diff and roll back to.

![CSV Table Editor overview](https://raw.githubusercontent.com/minlong8111/assets/main/csv-table-editor/screenshot-overview.png)

## Features

### Edit as a grid

- Opens CSV/TSV files in a spreadsheet-like grid — no external tools.
- Inline cell editing; add or remove rows and columns.
- Only the rows near the viewport are rendered, so long files scroll, sort and
  search without the editor building a DOM for every row.
- Full undo/redo through the standard `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z`.
- Saving a large file takes the time it needs and says so in the status bar; it
  never writes a partial or empty file to meet a deadline.

### Pick your encoding

Auto-detects BOM-marked files first, then checks BOM-less UTF-16, strict UTF-8
and a scored set of legacy encodings. You can always override the result and
reopen or save with any of these via the clickable encoding label:

- UTF-8, UTF-8 with BOM
- UTF-16 LE and UTF-16 BE, with or without a BOM
- Shift_JIS, EUC-JP
- Windows-1252, Latin-1 (ISO-8859-1)
- GBK, Big5, EUC-KR
- Windows-1258 (Vietnamese)

### Search, sort and headers

- Set `csvTableEditor.fontFamily` to any CSS font-family value. For example,
  `"Microsoft JhengHei", "Noto Sans TC", sans-serif`. Changes apply to both
  the editable grid and the streaming large-file preview.
- `Cmd/Ctrl+F` searches across every cell with match highlighting and navigation.
  Click a column header to search only that column. To return to whole-table
  search, click the same header again; in editing mode, click its background
  outside the title, sort arrow, and delete button.
- Click a row number to highlight that whole horizontal record in either the
  editable grid or large-file preview. Row highlighting in the preview preserves
  the current search scope, results, and match position.
- Automatic header-row detection, keeping any metadata preamble above the table.
- Three-state column sort (ascending → descending → original). Sorting is
  **view-only** — it never reorders the data written back to disk. In editing
  mode, clicking an unselected column's title or sort arrow selects it first;
  subsequent clicks sort it while keeping the column selected.
- Excel-style row and column highlighting for the selected cell, including
  clicked cells in the read-only preview. Preview cell clicks cancel any prior
  whole-column selection and restore search across all loaded rows, leaving
  only the clicked cell's row and column highlighted.

### History and diff

- Every save is captured as a version (the last 50 are kept), stored in the
  extension's global storage — not as stray files next to your CSV.
- Open the **History** panel from the toolbar to browse past versions.
- Compare any version with the current content in a side-by-side **table diff**
  that highlights added, removed and changed rows.
- Roll back to a version as unsaved changes, so you review before overwriting.

![Side-by-side table diff between a history version and the current content](https://raw.githubusercontent.com/minlong8111/assets/main/csv-table-editor/screenshot-diff.png)

## Usage

1. Open any `.csv` or `.tsv` file — it opens in the grid editor by default.
   To switch an already-open file, use **View: Reopen Editor With…** and pick
   **CSV Table Editor**.
2. Click a cell to edit. Use the toolbar buttons to add rows/columns.
3. Click the encoding label in the toolbar to reopen or save with a different
   encoding.
4. Click **History** to view, diff, or roll back to a previous save.
5. Press `Cmd/Ctrl+S` to save.

## Requirements

No additional setup. Encoding conversion is handled by the bundled
[`iconv-lite`](https://www.npmjs.com/package/iconv-lite) library.

Private automatic updates require the one-time authentication setup below.

The editable grid is an in-memory editor. Local files larger than 64 MiB open
in a streaming, read-only preview instead. Scrolling near either end loads the
adjacent 100 rows, so you can move forward and backward without keeping the
complete file in memory. The visible table stays bounded to 500 rows, supports
searching the loaded window (including column-only search) and lets you change the
detected encoding.
Loading adjacent pages keeps the visible record at the same screen position,
including when older rows leave the window or a search is active.

For files no larger than 511 MiB, **Enable Editing** can explicitly reopen the
full in-memory grid after a warning. Files above that JavaScript hard limit,
including multi-gigabyte CSV files, remain in the streaming preview. Adjust
the automatic preview threshold with `csvTableEditor.maxFileSizeMB`.

## Private automatic updates

Stable updates come exclusively from the private
[`Okamishimo/csv-table-editor` GitHub Releases](https://github.com/Okamishimo/csv-table-editor/releases).
This extension is packaged as a VSIX and is never published to the public
Marketplace. The extension ID remains `Edgar-Dang.csv-table-editor` so existing
installations are upgraded in place.

### First installation on each computer

1. Sign in to GitHub with access to the private repository and download
   `csv-table-editor-0.0.10-enhanced.vsix` (or a newer stable release). Versions
   up to 0.0.9 do not contain the updater, so they need this one manual upgrade.
2. In VS Code, run **Extensions: Install from VSIX…**, select the file, and
   reload VS Code. The updater supports installed desktop extensions on macOS
   and Windows. It does not update Remote SSH, WSL, container, web, or Extension
   Development Host installations.
3. Run **CSV Table Editor: Configure Private Update Authentication** and choose:
   - **Fine-grained GitHub token** (recommended for least privilege): create a
     token with resource owner `Okamishimo`, select **Only select repositories →
     csv-table-editor**, and grant **Contents: Read-only** (Metadata read access
     is implicit). Paste it into the password input. It is stored only in
     VS Code SecretStorage, not settings, files, Git, logs, or CLI arguments.
   - **Sign in with GitHub**: use VS Code's built-in authentication provider.
     VS Code manages the session; this extension does not store a copy. Private
     repository access requires the broader OAuth `repo` scope. Choose the
     fine-grained token if you want to limit access to this one repository.
4. Run **CSV Table Editor: Check for Extension Updates** to verify access.
   If you use a named VS Code profile, first set
   `csvTableEditor.updates.profileName` to its exact name in User Settings.
   Default profiles need no extra setting. No `code` PATH setup is required.

SecretStorage credentials do not sync between computers. Configure authentication
once on each computer/profile; repeat it when a token expires or is revoked.
Organization-managed repositories may require token approval or SSO authorization.
**Disconnect private updates** deletes this extension's token and stops using its
GitHub session; it does not sign other extensions out of GitHub.

### Update behavior and settings

- `csvTableEditor.updates.enabled` defaults to `true`. Disable it to stop
  automatic checks; the manual command still works.
- `csvTableEditor.updates.checkIntervalHours` defaults to `6` (range 1–168).
  The startup check waits 30 seconds; a lightweight timer checks whether an API
  request is due every five minutes. Attempt times persist across restarts, and
  failed requests also observe the interval. Manual checks bypass this interval
  but honor GitHub's rate-limit retry delay.
- Background checks never prompt for authentication. Configure it explicitly
  once using the command above. Draft/prerelease releases and versions no newer
  than the installed package are skipped.
- A new stable version is downloaded automatically with its SHA-256 file.
  Downloads are streamed, limited to 128 MiB, and time out after two minutes per
  request. The updater verifies the checksum, package identity, and exact version
  before calling this running VS Code installation's CLI with
  `--install-extension <vsix> --force`. It uses separate process arguments on
  both platforms and targets the current user-data and extension directories.
- After installation, **Reload Window** activates the new version; **Later**
  keeps the current window running. Other open windows need their own reload.
  A local lock prevents concurrent installs across windows sharing the same
  profile, and successful installation state prevents repeated downloads.
- Failures are isolated from CSV editing and logged to **Output → CSV Table
  Editor Updates**. Manual failures also show a message. Missing releases,
  unfinished release assets, expired credentials, and network errors can be
  retried with the manual command after the underlying problem is fixed.

### GitHub setup and publishing

The workflow is [`.github/workflows/private-release.yml`](.github/workflows/private-release.yml).
Enable GitHub Actions for the repository and allow the workflow's job-level
`contents: write` permission. No custom repository Secrets, PAT, or Marketplace
publisher token are needed: the upload uses GitHub's short-lived `GITHUB_TOKEN`.
Client read tokens belong only in each computer's VS Code SecretStorage.

The workflow runs when a `v*` tag is pushed or a Release is published. It checks
out that tag, verifies it matches `package.json`, installs dependencies with
`npm ci`, runs `npm run build` and the tests, checks patch idempotency, and runs
`vsce package --no-dependencies`. This repository's build applies the validated
distribution patches and checks JavaScript syntax; it does not run the obsolete
webpack compile task because the original TypeScript/webpack project is absent.

For the first updater release, commit all 0.0.10 changes, push the branch, then:

```sh
git tag v0.0.10
git push origin v0.0.10
```

For subsequent releases, increment the version and lockfile, update the changelog,
commit every intended change, then push the matching new tag. For example:

```sh
npm version patch --no-git-tag-version
# Update changelog.md and review the changes before committing.
git add .
git commit -m "Release 0.0.11"
git push origin main
git tag v0.0.11
git push origin v0.0.11
```

Alternatively, publish a GitHub Release using that same tag. Use stable `vX.Y.Z`
tags. The workflow creates a draft when necessary, uploads the canonical VSIX and
`<vsix>.sha256`, then publishes it. On an existing published Release it uploads
the assets directly; wait for Actions to finish before checking for updates.
The updater follows GitHub's **latest stable release**; when publishing an older
maintenance version, keep the desired newest version marked Latest in GitHub.

Existing assets are never overwritten. Duplicate tag/release events skip a
release that already has both assets. If both assets uploaded but the final
publication failed, a retry using the corrected release script publishes the
existing draft and skips packaging. Drafts are resolved by their pending tag
through GraphQL because the REST tag endpoint only returns published releases.
A partially uploaded release fails safely:
retain the existing asset, use a new patch version/tag for a fresh build, and
leave the incomplete release as a draft. Do not move or reuse a published tag.
Every release keeps one canonical `csv-table-editor-<version>-enhanced.vsix`.

For local packaging after tests pass, use the installed VSCE binary with the same
canonical filename (on Windows, `node_modules\\.bin\\vsce.cmd`). Never overwrite
an existing version. GitHub Actions verifies runtime modules, the vendor bundle,
manifest, documentation, license, and media are present and generates SHA-256.

Authentication and installation references:
[VS Code SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage),
[GitHub release asset permissions](https://docs.github.com/en/rest/releases/assets),
[VS Code CLI](https://code.visualstudio.com/docs/configure/command-line).

## Known limitations

- Legacy encodings can be inherently ambiguous for very short files. Use the
  clickable encoding label to override a guess when needed.
- Sorting and header detection are heuristic; a header can be one row off on
  unusual files.
- The table diff compares serialized CSV text, so purely formatting-level
  differences (quoting style) may show as changes.
- History is keyed by file path — renaming or moving a file starts a fresh
  history.
- The editable grid keeps only the rows near the viewport in the DOM, so very
  wide files (hundreds of columns) are now the practical limit rather than very
  long ones. Every row still lives in memory, so `csvTableEditor.maxFileSizeMB`
  continues to govern how large a file may be edited rather than previewed.

## License

[MIT](https://github.com/minlong8111/csv-table-editor/blob/HEAD/LICENSE)
