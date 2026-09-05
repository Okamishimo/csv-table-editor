# AGENTS.md

## Scope

These instructions apply to the entire repository.

## Project Overview

This repository contains a customized VS Code CSV/TSV table editor. It supports
editable in-memory grids, encoding detection and conversion, save history,
column-scoped search, configurable fonts, and a streaming read-only preview for
large files.

The project is not laid out like a normal source-first VS Code extension. The
original extension runtime is the minified, checked-in `dist/extension.js`.
Custom behavior lives in readable CommonJS modules under `src/` and is wired
into the original runtime by `scripts/patch-distribution.js`.

## Repository Map

- `dist/extension.js`: Original minified extension bundle and runtime entry
  point. Treat it as a vendor artifact.
- `scripts/patch-distribution.js`: Idempotently connects the custom modules to
  the minified bundle by replacing exact, validated anchors.
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
- `test/`: Node test runner and JSDOM integration tests.
- `package.json`: VS Code manifest, settings, dependencies, and scripts.
- `README.md` and `CHANGELOG.md`: User-facing behavior and release notes.

## Non-Negotiable Editing Rules

1. Preserve existing user changes. The worktree may contain deliberate edits
   that are not represented by version control.
2. Do not prettify, mechanically rewrite, or hand-edit `dist/extension.js`.
   Implement readable behavior in `src/`, then update
   `scripts/patch-distribution.js` only when the bundle needs a new integration
   hook.
3. Do not run `npm run compile` as a routine build step. The readable original
   TypeScript sources and webpack configuration are not present, and rebuilding
   may fail or replace the customized distribution.
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
   ```

   `grid-performance.js` intentionally patches HTML already produced by the
   other two decorators.
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

Search scope is column-based:

- With no whole column selected, search the entire table or the currently
  loaded large-file window.
- Clicking a column header limits search to that column.
- Clicking the same column header again clears the scope.
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
- Automatic loading must be triggered by real user scrolling. Rendering,
  searching, or filtering must not start an uncontrolled page-request chain.
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

Do not weaken strict UTF-8 validation or collapse BOM and non-BOM UTF-16 menu
entries. Encoding changes in large-file mode must reset the stream and page
cache instead of reusing data decoded with the previous encoding.

## Testing Workflow

Use the smallest relevant test while developing, then run the complete suite.

```powershell
node --test test\bundle-integration.test.js
node --test test\grid-performance.test.js
node --test test\large-file-webview.test.js
```

Before handing off a behavior change, run:

```powershell
npm run patch:dist
npm test
node --check dist\extension.js
npm run patch:dist
```

The second patch run verifies idempotency. Run `node --check` on every changed
JavaScript file as well.

Tests that exercise Webview behavior should use the actual generated Webview
HTML in JSDOM rather than a simplified copy. Stub `scrollIntoView` where JSDOM
does not implement it. For UI changes, verify both visible state and behavior:
selection scope, result count, keyboard navigation, scrolling, and message
traffic as applicable.

Never solve a failing test by weakening an important memory, performance, or
scope assertion. Update an assertion only when the product requirement has
actually changed.

## Documentation

Update `README.md` when user-visible behavior, settings, limits, or usage
changes. Add unreleased changes to the `[Unreleased]` section of `CHANGELOG.md`.
Keep descriptions aligned with the row/column terminology above.

## Packaging and Releases

Do not create a VSIX unless the user explicitly asks for packaging.

`npm run package` currently applies the distribution patch and runs tests; it
does not itself create a VSIX. To create the installable artifact, use the local
VSCE binary after tests pass:

```powershell
.\node_modules\.bin\vsce.cmd package --no-dependencies --out csv-table-editor-<version>-enhanced.vsix
```

Packaging invokes `vscode:prepublish`, so expect the patch and full tests to run
again.

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
development dependencies, and existing VSIX files while retaining the runtime
`src/` modules required by `dist/extension.js`.
