# AGENTS.md

## Scope

These instructions apply to the entire repository.

## Project Overview

This repository contains a customized VS Code CSV/TSV table editor. It supports
editable in-memory grids, encoding detection and conversion, save history,
column-scoped search, configurable fonts, a streaming read-only preview for
large files, and private GitHub Release updates on macOS and Windows.

The project is not laid out like a normal source-first VS Code extension. The
original extension runtime is the minified, checked-in `dist/extension.js`.
Custom behavior lives in readable CommonJS modules under `src/` and is wired
into the original runtime by `scripts/patch-distribution.js`.

## Repository Map

- `dist/extension.js`: Original minified extension bundle and runtime entry
  point. Treat it as a vendor artifact.
- `scripts/patch-distribution.js`: Idempotently connects the custom modules to
  the minified bundle by replacing exact, validated anchors.
- `scripts/check-syntax.js`: Checks JavaScript syntax in `src/`, `scripts/`,
  `test/`, and `dist/` without rebuilding the vendor bundle.
- `scripts/verify-patch-idempotency.js`: Reapplies the distribution patch and
  asserts that the resulting bundle is byte-for-byte unchanged.
- `scripts/private-release.js`: Release version validation, draft/published
  release lookup, package verification, checksum generation, and publication.
- `.github/workflows/private-release.yml`: Builds and packages tagged versions,
  then uploads the VSIX and checksum to the private GitHub Release.
- `src/encoding-detector.js`: BOM, BOM-less UTF-16, strict UTF-8, and scored
  legacy-encoding detection.
- `src/large-file-guard.js`: Editable-grid size limits and oversized-file
  protection.
- `src/large-file-mode.js`: Streaming parser, disk-backed page cache, large-file
  document/provider behavior, and the read-only preview Webview.
- `src/font-settings.js`: Free-form `csvTableEditor.fontFamily` support and live
  setting updates.
- `src/search-scope.js`: Decorates the editable Webview with column-scoped
  search behavior.
- `src/grid-performance.js`: Performance decorator applied after the font and
  search decorators.
- `src/grid-virtualization.js`: Row virtualization for the editable grid,
  applied last in the decorator chain.
- `src/private-updater.js`: Commands, authentication, persistent check timing,
  cross-window locking, installation coordination, and reload prompts.
- `src/github-release-client.js`: Authenticated GitHub API access and bounded
  streaming downloads with restricted redirects and sanitized errors.
- `src/update-artifact.js`: Stable version comparison, release asset selection,
  checksum parsing, and bounded VSIX manifest validation.
- `src/update-installer.js`: Invokes the running VS Code installation's CLI
  using the correct local user-data, extension directory, and profile.
- `test/`: Node test runner and JSDOM integration tests.
- `package.json`: VS Code manifest, settings, dependencies, and scripts.
- `readme.md` and `changelog.md`: User-facing behavior and release notes. Use
  these exact lowercase filenames; GitHub Actions runs on Linux.

## Non-Negotiable Editing Rules

1. Preserve existing user changes. The worktree may contain deliberate edits
   that are not represented by version control.
2. Do not prettify, mechanically rewrite, or hand-edit `dist/extension.js`.
   Implement readable behavior in `src/`, then update
   `scripts/patch-distribution.js` only when the bundle needs a new integration
   hook.
3. Do not run `npm run compile` as a routine build step. The readable original
   TypeScript sources and webpack configuration are not present, and rebuilding
   may fail or replace the customized distribution. Use `npm run build`, which
   applies the distribution patch and checks JavaScript syntax.
4. Keep distribution patches idempotent. A patch must:
   - replace exactly one known source anchor;
   - recognize the already-patched form;
   - fail loudly if neither form is present;
   - produce identical behavior when run more than once.
5. Keep the editable Webview decorator order unchanged unless all dependent
   anchors and tests are updated together:

   ```text
   original Webview HTML
     -> font-settings
     -> search-scope
     -> grid-performance
     -> grid-virtualization
   ```

   Every decorator after the first intentionally patches HTML already produced
   by the ones before it. `grid-virtualization.js` runs last because it
   rewrites the render, search and match-navigation paths that
   `grid-performance.js` installs.
6. Respect the Webview content security policy. Do not add inline event-handler
   attributes or unapproved scripts/styles. Prefer the existing nonce-bearing
   script and stylesheet, event delegation, CSS classes, or validated
   stylesheet rules.
7. Use CommonJS (`require`/`module.exports`) and follow the style of the file
   being edited.

## Row and Column Terminology

Use these terms consistently in code, tests, documentation, and UI text:

- A **row** is a horizontal CSV record and is selected by its row number.
- A **column** is a vertical field/value series and is selected by its column
  header.

Both modes support whole-row highlighting from row-number clicks. In the
large-file preview this is visual state independent of column search scope:
do not clear the selected search column, rescan, or reset match navigation when
highlighting a row. Preserve the editable grid's existing selection/search
behavior. Keep preview row highlighting delegated and apply a class to the row
as a unit, without per-cell listeners or classes.

Clicking a data cell in the preview cancels any whole-column selection and
restores search across the loaded window without scrolling away from the click.
Only the clicked cell's row and column stay highlighted. Subsequent cell clicks
without a whole-column selection must not rescan or reset match navigation.
Track only the active cell and row, and paint the column
with one reusable rule in the nonce-approved stylesheet. Clear the active cell
and column highlights when their row leaves the loaded window or a row/column
header is clicked; row-number clicks still highlight the requested whole row.

In the editable grid, clicking an unselected column's title or sort arrow only
selects the whole column. Sorting requires that same whole column to already be
selected; retain its selection while cycling through the three sort states.
A focused cell or selected row does not satisfy this requirement.

Search scope is column-based:

- With no whole column selected, search the entire table or the currently
  loaded large-file window.
- Clicking a column header limits search to that column.
- Clicking the same column header again clears the scope. In the editable grid,
  this means the header background outside the title, sort arrow, and delete
  button; the title and sort arrow follow the selection requirement above.
- Clicking a row number must never limit the search.
- Focusing an ordinary cell is not a whole-column selection and therefore uses
  whole-table search.

Any change to this behavior must cover both the editable grid and the
large-file preview and must include explicit tests proving that row-number
clicks do not alter search scope.

## Large-File Safety and Performance

Large-file protections are correctness requirements, not optional tuning.

- The editable in-memory grid defaults to a 64 MiB threshold, configured by
  `csvTableEditor.maxFileSizeMB`.
- The hard full-edit limit is 511 MiB because of V8 string limits.
- Files above the editable threshold open in the streaming, read-only preview.
- The parser must never read or decode an entire oversized file into one
  string.
- Streaming pages contain 100 rows.
- The Webview keeps at most 500 rendered data rows.
- Preview output is capped at 100 columns, 4,096 characters per cell, and
  32,768 characters per row.
- Keep parsing cooperative and bounded. Do not remove chunking or event-loop
  yields without equivalent protection.
- Preserve bidirectional scrolling through cached pages. Page cache files must
  be unique per document and removed when the document closes.
- Preserve a visible row's measured screen position across page insertion and
  eviction; do not estimate offsets from one row's height. Keep browser scroll
  anchoring disabled on the preview scroller and ignore compensation scroll
  events. Refresh search highlights during paging without scrolling to a match.
- Automatic loading must be triggered by real user scrolling. Rendering,
  searching, or filtering must not start an uncontrolled page-request chain.
- The editable grid renders only the rows near the viewport, with two spacer
  rows standing in for the rest so the scrollbar keeps measuring the whole
  file. Measure the row height instead of assuming it, and render every row
  when the viewport cannot be measured rather than guessing.
- Rebuilding the rendered window must not lose an edit in progress. Commit the
  focused cell first: removing a focused element does not reliably fire
  `focusout`, so the edit would otherwise reach neither the undo stack nor the
  saved file.
- Match highlighting must cost the rendered window rather than the number of
  matches. Preserve the per-row match index; a common word matches hundreds of
  thousands of cells.
- Keep browser scroll anchoring disabled on the editable scroller, as on the
  preview scroller. It would otherwise compensate for the rows the window swaps
  and fight the spacer arithmetic.
- Pin the editable grid's column widths from the first measured window and
  reapply them whenever the head is rebuilt. Automatic table layout sizes
  columns from the rows it can see, so an unpinned virtual table resizes itself
  as the reader scrolls. Re-measure when the column count changes or a new file
  is loaded, and leave the layout automatic when nothing can be measured.
- Avoid whole-table DOM scans on selection and match navigation. Preserve the
  indexed lookup, tracked highlight collections, debounced search, and bounded
  large-preview DOM.
- When adding fields to preview rows, consider the worst case of 500 rows by
  100 columns before adding per-cell listeners, attributes, titles, or stored
  objects. Prefer event delegation and lazy work.

## Encoding Behavior

Detection order is intentional:

1. BOM-marked encodings.
2. BOM-less UTF-16 heuristics.
3. Strict UTF-8 validation.
4. Scored legacy encodings.

Only the legacy scorer samples, and it samples 256 KiB. ASCII and strict UTF-8
validation read the whole buffer on purpose: a CSV whose leading rows are plain
ASCII must still be classified by the bytes that follow them, or every Japanese
export with an ASCII header would be read as UTF-8. Detection views the
caller's bytes rather than copying them, so it must accept an offset
`Uint8Array` as `vscode.workspace.fs.readFile` returns.

Do not weaken strict UTF-8 validation or collapse BOM and non-BOM UTF-16 menu
entries. Encoding changes in large-file mode must reset the stream and page
cache instead of reusing data decoded with the previous encoding.

## Private Automatic Updates

- Updates come only from `Okamishimo/csv-table-editor`, a private GitHub
  repository. Do not publish this extension to the public VS Code Marketplace.
  Preserve the extension ID `Edgar-Dang.csv-table-editor` so existing
  installations are upgraded in place.
- `onStartupFinished` activates the extension. The distribution hook registers
  the CSV editor before starting the updater, and isolates updater initialization
  failures. Keep updates independent of normal CSV editing.
- Preserve commands `csvTableEditor.checkForUpdates` and
  `csvTableEditor.configureUpdateAuthentication`. Background checks must not
  prompt for login; authentication is configured explicitly through the command.
- Fine-grained tokens belong only in `ExtensionContext.secrets` (SecretStorage),
  scoped to this repository with Contents read access. The alternative is the
  built-in GitHub authentication provider with `repo` scope: let VS Code manage
  its session and use `{ silent: true }` for background session retrieval.
  Never put tokens in source, settings, Git, state files, logs, or installer
  arguments. Client credentials are separate from Actions' `GITHUB_TOKEN`.
- Automatic checks default to six hours, configurable from 1 to 168 hours with
  `csvTableEditor.updates.checkIntervalHours`. This is a product default, not an
  API requirement. The initial timer waits 30 seconds; the five-minute timer
  only checks whether a request is due. `csvTableEditor.updates.enabled` controls
  automatic checks; manual checks bypass the interval but honor rate-limit delays.
- Persist the attempt time before API access, including failed attempts. Keep
  the lock, atomic state writes, installed-version marker, interrupted-host
  recovery, and cleanup under the extension's global storage. Multiple windows
  sharing a profile must not concurrently install or repeatedly download an update.
- Only install a newer stable release with the canonical
  `csv-table-editor-<version>-enhanced.vsix` and matching `.vsix.sha256` asset.
  Verify SHA-256, publisher, extension name, and exact package version before
  installation. Keep ZIP manifest reads bounded; do not extract the whole archive.
- Stream VSIX downloads with the 128 MiB cap and two-minute request deadline.
  Keep metadata/checksum limits and redirect limits. Send authorization only to
  the configured repository's HTTPS GitHub API paths, never to redirected asset
  hosts. Reject unexpected hosts and preserve sanitized errors.
- Use the running app's CLI via `execFile` with separate arguments and
  `shell: false`; do not depend on PATH or build a Windows shell command string.
  Preserve the current user-data and extension directories. Named profiles require
  the exact `csvTableEditor.updates.profileName`; default profiles need no value.
- Updater installation supports local production extension hosts on macOS and
  Windows. Preserve the remote/development-host guards. Release the lock before
  showing Reload/Later, and avoid repeated automatic prompts for the same version.
- Update failures must leave the editor usable and log to
  `CSV Table Editor Updates`. Keep checksums and failed downloads from becoming
  an installed-version marker. Tests must stub authentication, network, and CLI
  installation instead of modifying the user's installed extension.
- Version 0.0.10 is the first updater-enabled build. Versions through 0.0.9 need
  one manual VSIX upgrade, followed by authentication setup on each computer.

## Testing Workflow

Use the smallest relevant test while developing, then run the complete suite.

```powershell
node --test test/bundle-integration.test.js
node --test test/grid-performance.test.js
node --test test/large-file-webview.test.js
node --test test/private-updater.test.js test/github-release-client.test.js
node --test test/private-release.test.js
```

Before handing off a behavior change, run:

```powershell
npm run patch:dist
npm test
node --check dist/extension.js
npm run patch:dist
node scripts/check-syntax.js
node scripts/verify-patch-idempotency.js
```

The second patch run must recognize the already-patched bundle, and the
idempotency script additionally asserts byte-for-byte equality. The syntax
script runs `node --check` on the project's JavaScript files. The forward-slash
paths above work on macOS, Linux, and PowerShell.

For updater/release changes, cover authentication isolation, failed-attempt
throttling across restarts, rate limits, checksum/identity rejection, download
cleanup, cross-window locking, reload behavior, and macOS/Windows CLI arguments
as relevant. Release tests must cover creating a draft, finding it again,
finishing a fully uploaded draft on retry, and refusing partial-asset overwrites.
Unit tests must not publish real releases. Distinguish mocked platform checks
from actual installation or GitHub Actions verification when reporting results.

Tests that exercise Webview behavior should use the actual generated Webview
HTML in JSDOM rather than a simplified copy. Stub `scrollIntoView` where JSDOM
does not implement it. For UI changes, verify both visible state and behavior:
selection scope, result count, keyboard navigation, scrolling, and message
traffic as applicable.

Never solve a failing test by weakening an important memory, performance, or
scope assertion. Update an assertion only when the product requirement has
actually changed.

## Documentation

Update `readme.md` when user-visible behavior, settings, limits, or usage
changes. Add unreleased changes to the `[Unreleased]` section of `changelog.md`.
Keep descriptions aligned with the row/column terminology above.

## Packaging and Releases

Do not create a VSIX unless the user explicitly asks for packaging.

`npm run package` currently applies the distribution patch and runs tests; it
does not itself create a VSIX. To create the installable artifact, use the local
VSCE binary after tests pass:

```powershell
.\node_modules\.bin\vsce.cmd package --no-dependencies --out csv-table-editor-<version>-enhanced.vsix
```

On macOS/Linux, use `./node_modules/.bin/vsce`. If copied dependencies leave that
wrapper without execute permission, invoke the installed CLI directly with
`node node_modules/@vscode/vsce/vsce` rather than changing the build process.
Packaging invokes `vscode:prepublish` (`npm run build && npm test`), so expect
syntax checks, the distribution patch, and the full tests to run again.

Every package containing new changes must use a newly incremented semantic
version, normally the next patch version. Never overwrite or reuse an existing
version number for a changed build. Keep all older-version VSIX artifacts.

Create exactly one VSIX for the new version containing every change currently
in the workspace, regardless of whether the user or an agent authored it. Use
the canonical `-enhanced.vsix` name; do not create separate `-custom`,
`-agent`, `-combined`, or other author-specific artifacts. If the target VSIX
for the intended version already exists, stop and increment the project
version instead of replacing it.

After packaging:

- confirm the VSIX exists and report its absolute path and byte size;
- verify that `src/`, `dist/extension.js`, the manifest, README, changelog,
  license, and media assets are included;
- confirm tests passed;
- compute and report a SHA-256 hash.

The `.vscodeignore` file intentionally excludes tests, patch scripts,
development dependencies, `.github/`, `AGENTS.md`, and existing VSIX/checksum
files while retaining the runtime `src/` modules required by `dist/extension.js`.
Do not add a runtime dependency under `node_modules` without ensuring it will
be included or bundled: packaging uses `--no-dependencies`.

### GitHub Actions Publication and Recovery

- The workflow runs on pushed `v*` tags and published Releases, checks out the
  triggering tag, and uses Node 22 with `npm ci`. Stable tags must be exactly
  `v<package.json version>`; keep `package-lock.json` in sync with version changes.
  Commit and push the release changes to the branch before pushing its tag.
- Publication uses the job's `contents: write` permission and short-lived
  `GITHUB_TOKEN`; no custom PAT or Marketplace Secret is required. The workflow
  builds, tests, checks patch idempotency, packages, verifies contents, and
  uploads the canonical VSIX plus `.vsix.sha256`.
- Keep concurrency keyed to the release tag, without cancelling an active
  publication. Duplicate tag/release events must skip packaging when both
  assets are already uploaded; they may finish publication of that same draft.
- REST `GET /repos/{owner}/{repo}/releases/tags/{tag}` only finds published
  releases. Preserve the GraphQL pending-tag lookup followed by REST lookup by
  release ID in `existingRelease()`. Do not treat permission/network errors as
  an absent release, or fix a missing draft merely by ignoring a null property.
- The first v0.0.10 workflow uploaded both assets but failed on `null.draft`
  because it re-queried a draft through the published-tag endpoint. When
  diagnosing release failures, inspect the failing step and existing draft/assets
  before retrying or attempting any new package.
- If both assets are already uploaded, verify their checksum and VSIX identity,
  then use the corrected release logic to finish the existing draft. Preserve
  the exact assets and tag; this recovery does not create a changed build.
  A partial upload must not be overwritten: retain the existing asset and use a
  new version/tag for a fresh package.
- A workflow rerun still checks out its original tag. A fix pushed to `main`
  does not update an old tag's script. Recover a fully uploaded draft with the
  corrected logic before rerunning the old workflow; do not move the tag.
- Confirm the run conclusion, published release state, asset names/sizes, and
  checksum after publication. An upload succeeding alone does not mean the
  release is published or visible to the updater's latest-stable-release query.
