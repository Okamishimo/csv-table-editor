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
  extension's global storage — not as stray files next to your CSV. Rapid saves
  are recorded in order, including the cell still being edited.
- Open the **History** panel from the toolbar to browse past versions.
- Compare any version with the current content in a side-by-side **table diff**
  that highlights changed cells, added or removed rows, and added or removed
  columns. It jumps to the first change automatically; use **↑ / ↓** or
  **Shift+F7 / F7** to move between changed rows.
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
complete file in memory. The visible table stays bounded to 500 rows and lets
you change the detected encoding.

The preview reads the whole file before you browse it. A progress bar reports
that read; while it runs the table is covered and search is unavailable,
because the length of the file, and therefore the meaning of the scrollbar, is
not yet known. Choosing another encoding reads the file again. A file that
cannot be read through is still previewed, with the scrollbar bounded to the
loaded window.

Once the read has finished the scrollbar spans the whole file: everything
outside the loaded window is shown as placeholder space, so the thumb tells you
how far from the end you are. Dragging it anywhere loads that part of the file
directly, and the status line reads `Rows 4,902–5,401 of 12,480,913`.

Rows are loaded for where you stop, not for everywhere you passed: a wheel or
trackpad gesture, and a scrollbar drag, load one window once the scroller has
come to rest.

Typing highlights the rows already loaded. Press **Enter** to search downward
from the first visible row, continuing beyond the loaded window and stopping at
the first matching cell. The preview jumps to that result and does not wrap to
the top of the file. Clicking a column header limits the search to that column.
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

The complete contributor and agent policy is in
[Release rules](.github/release-rules.md); Codex reads it for Git, PR and release tasks
through the instruction in `AGENTS.md`.

For release preparation, use the project's `release-preflight` skill in Codex,
or `/release-preflight` in Claude Code. You can also ask either agent to perform
a release preflight in plain language. Both use the same
[preflight procedure](.claude/skills/release-preflight/SKILL.md), covering versions,
changes, tests, PR checks, tags and workflow readiness. A preflight request alone
does not commit, push, merge or publish. Reopen the project session if the newly
added skill does not appear.

The workflow is [`.github/workflows/private-release.yml`](.github/workflows/private-release.yml).
Enable GitHub Actions for the repository and allow the workflow's job-level
`contents: write` permission. No custom repository Secrets, PAT, or Marketplace
publisher token are needed: the upload uses GitHub's short-lived `GITHUB_TOKEN`.
Client read tokens belong only in each computer's VS Code SecretStorage.

Develop on a topic branch and merge through a PR. Release PRs into `main` must be
named `Release vX.Y.Z: description`, for example
`Release v0.0.16: protect the release workflow`. The stable version must match
`package.json` and both root version fields in `package-lock.json`, be newer
than main, and not already have a tag. `PR policy` and `Verify` checks validate
these rules and run the complete build, tests, and patch idempotency check.
Editing the PR title reruns the checks.

Documentation-only PRs use `Docs: description`, for example
`Docs: clarify the release guide`. They require no version bump and create no tag
or Release after merging. Quick CI checks validate the full PR diff against a
strict documentation allowlist and run `git diff --check`; no dependency install
or full test suite is needed for this PR type. `Verify` records the successful
quick checks while retaining the same required check names as Release PRs.

The allowlist covers `readme.md`, `changelog.md`, `AGENTS.md`, `CLAUDE.md`,
`.github/release-rules.md`, Markdown under `docs/`, and `SKILL.md` or Markdown
references in named skills under `.agents/skills/` and `.claude/skills/`.
Source code, tests, scripts, workflows, manifests, lockfiles, hooks, configuration,
and media require a Release PR. Mixing any of them into a Docs PR fails, even if
code is renamed into a Markdown path. Symlinks and executable files also fail.
The local pre-commit hook continues to run full staged verification for every
commit; only documentation PR CI uses quick checks.

Install dependencies with `npm ci` after cloning. This also installs the tracked
Git hooks; existing checkouts can use `npm run hooks:install`. Before each
commit, the hook runs `npm run verify` on an isolated copy of the **staged** files
using the checkout's installed dependencies. Unstaged fixes cannot hide failures
in the commit. If the build changes the staged vendor distribution, run
`npm run build` and stage the generated change before retrying. The working tree
and index are left intact. Keep installed dependencies current with `npm ci`.

```sh
git switch -c release/0.0.16
npm version patch --no-git-tag-version
# Update changelog.md, make changes, and review before staging.
git add .
git commit -m "Release v0.0.16: protect the release workflow"
git push -u origin release/0.0.16
gh pr create --base main --title "Release v0.0.16: protect the release workflow" --body-file /path/to/pr-description.md
```

After a Release PR is merged, `merge-release.yml` tags its exact merge commit and
calls `private-release.yml` directly. This works with `GITHUB_TOKEN` alone:
[tags created with that token do not trigger another push workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
A retry reuses an existing tag only when it points to the same commit; it never
moves a tag. Merely closing a PR does not create a tag.

Manual `v*` tag pushes and published Releases also invoke the release workflow.
All release paths check that the tag's commit is already reachable from remote
main before preparing assets. The pre-push hook blocks direct main pushes and
rejects all tag pushes outside freshly fetched `origin/main`, along with tag
deletions/replacements. A tag identifies a commit, not a branch: a commit already
merged into main is allowed even if another branch also contains it.

The release workflow checks out the tag, validates its package version, installs
dependencies with `npm ci`, runs `npm run verify`, and packages with
`vsce package --no-dependencies`. The build applies distribution patches and
checks syntax; it does not run the obsolete webpack compile task. Publication
creates a draft when needed, uploads the canonical VSIX and checksum, then
publishes it. Wait for Actions to finish before checking for extension updates.
The updater follows GitHub's latest stable release; keep the desired newest
version marked Latest when publishing older maintenance versions.

#### Server protection setup

On 2026-09-06 GitHub rejected protection API access with HTTP 403 because this
private repository's plan requires **GitHub Pro**. Local hooks and CI are present,
but server protection is **not enabled**. Keep the repository private. Once the
account supports private repository protections, run from the repository root:

```sh
gh api --method PUT repos/Okamishimo/csv-table-editor/branches/main/protection --input .github/main-protection.json
gh api --method POST repos/Okamishimo/csv-table-editor/rulesets --input .github/tag-protection.json
```

Apply these after the PR workflow is on main and its checks have run. Main then
requires PRs, passing `PR policy` and `Verify` checks from GitHub Actions, an
up-to-date branch, and resolved conversations. Administrators are included;
force pushes and deletion are disabled. No extra reviewer approval is required.
The tag ruleset forbids updating/deleting tags; inspect existing rulesets before
applying it again to avoid duplicates.

GitHub tag rules have no native "commit belongs to main" condition. The hooks
can be bypassed and release CI rejects an invalid tag **after** it reaches GitHub.
To prohibit all manual tag creation server-side, configure a dedicated GitHub
App as the only bypass actor for a tag-creation restriction and let that App's
workflow validate main ancestry before creating tags. This extra App setup is
not enabled by the supplied configurations.

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
- The diff matches columns by header name, so two columns that swapped places
  are reported as one removed and one added rather than as a move.
- History is keyed by file path — renaming or moving a file starts a fresh
  history.
- The editable grid keeps only the rows near the viewport in the DOM, so very
  wide files (hundreds of columns) are now the practical limit rather than very
  long ones. Every row still lives in memory, so `csvTableEditor.maxFileSizeMB`
  continues to govern how large a file may be edited rather than previewed.

## License

[MIT](https://github.com/minlong8111/csv-table-editor/blob/HEAD/LICENSE)
