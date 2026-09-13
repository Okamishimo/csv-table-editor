# Releasing and repository setup

Maintainer material: the PR kinds, the release workflow, and GitHub protection. Back to the [readme](../readme.md).

The complete contributor and agent policy is in [Release rules](../.github/release-rules.md); Codex reads it for Git, PR and release tasks through the instruction in `AGENTS.md`.

For release preparation, use the project's `release-preflight` skill in Codex, or `/release-preflight` in Claude Code. You can also ask either agent to perform a release preflight in plain language. Both use the same [preflight procedure](../.claude/skills/release-preflight/SKILL.md), covering versions, changes, tests, PR checks, tags and workflow readiness. A preflight request alone does not commit, push, merge or publish. Reopen the project session if the newly added skill does not appear.

The workflow is [`.github/workflows/private-release.yml`](../.github/workflows/private-release.yml). Enable GitHub Actions for the repository and allow the workflow's job-level `contents: write` permission. No custom repository Secrets, PAT, or Marketplace publisher token are needed: the upload uses GitHub's short-lived `GITHUB_TOKEN`. The public updater requires no client credentials. The existing workflow filename is retained for compatibility.

## Pull requests

Develop on a topic branch and merge through a PR; GitHub refuses direct pushes to `main`. New behavior uses `Feature: description` and corrections use `Fix: description`. Neither changes the version, and merging one creates no tag or Release; the work waits on main until a release publishes it. Release PRs into `main` must be named `Release vX.Y.Z: description`, for example `Release v0.0.16: protect the release workflow`. The stable version must match `package.json` and both root version fields in `package-lock.json`, be newer than main, and not already have a tag. `PR policy` and `Verify` checks validate these rules and run the complete build, tests, and patch idempotency check. Editing the PR title reruns the checks.

Documentation-only PRs use `Docs: description`, for example `Docs: clarify the release guide`. They require no version bump and create no tag or Release after merging. Quick CI checks validate the full PR diff against a strict documentation allowlist and run `git diff --check`; no dependency install or full test suite is needed for this PR type. `Verify` records the successful quick checks while retaining the same required check names as Release PRs.

The allowlist covers `readme.md`, `changelog.md`, `AGENTS.md`, `CLAUDE.md`, `.github/release-rules.md`, Markdown under `docs/`, and `SKILL.md` or Markdown references in named skills under `.agents/skills/` and `.claude/skills/`. Source code, tests, scripts, workflows, manifests, lockfiles, hooks, configuration, and media require a Feature, Fix, or Release PR. Mixing any of them into a Docs PR fails, even if code is renamed into a Markdown path. Symlinks and executable files also fail. The local pre-commit hook continues to run full staged verification for every commit; only documentation PR CI uses quick checks.

## Working locally

Install dependencies with `npm ci` after cloning. This also installs the tracked Git hooks; existing checkouts can use `npm run hooks:install`. Before each commit, the hook runs `npm run verify` on an isolated copy of the **staged** files using the checkout's installed dependencies. Unstaged fixes cannot hide failures in the commit. If the build changes the staged vendor distribution, run `npm run build` and stage the generated change before retrying. The working tree and index are left intact. Keep installed dependencies current with `npm ci`.

```sh
git switch -c release/0.0.16
npm version patch --no-git-tag-version
# Update changelog.md, make changes, and review before staging.
git add .
git commit -m "Release v0.0.16: protect the release workflow"
git push -u origin release/0.0.16
gh pr create --base main --title "Release v0.0.16: protect the release workflow" --body-file /path/to/pr-description.md
```

## Tagging and publication

After a Release PR is merged, `merge-release.yml` tags its exact merge commit and calls `private-release.yml` directly. This works with `GITHUB_TOKEN` alone: [tags created with that token do not trigger another push workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow). A retry reuses an existing tag only when it points to the same commit; it never moves a tag. Merely closing a PR does not create a tag.

Manual `v*` tag pushes and published Releases also invoke the release workflow. All release paths check that the tag's commit is already reachable from remote main before preparing assets. The pre-push hook blocks direct main pushes and rejects all tag pushes outside freshly fetched `origin/main`, along with tag deletions/replacements. A tag identifies a commit, not a branch: a commit already merged into main is allowed even if another branch also contains it.

The release workflow checks out the tag, validates its package version, installs dependencies with `npm ci`, runs `npm run verify`, and packages with `vsce package --no-dependencies`. The build applies distribution patches and checks syntax; it does not run the obsolete webpack compile task. Publication creates a draft when needed, uploads the canonical VSIX and checksum, then publishes it. Wait for Actions to finish before checking for extension updates. The updater follows GitHub's latest stable release; keep the desired newest version marked Latest when publishing older maintenance versions.

## Server protection setup

Protection is enforced by two repository rulesets. The repository is public, so no paid plan is needed; while it was private, GitHub rejected protection with HTTP 403 and required **GitHub Pro**. As of 2026-09-13 both rulesets are active:

- **Protect main** ([`.github/main-protection.json`](../.github/main-protection.json)) targets `main`. Every change must arrive through a merged PR: direct pushes, force pushes and deletion are refused. Merging requires passing `PR policy` and `Verify` checks from GitHub Actions, a branch up to date with main, and resolved conversations; a new push dismisses earlier approvals. No extra reviewer approval is required. There are no bypass actors, so administrators follow the same rules.
- **Immutable tags** ([`.github/tag-protection.json`](../.github/tag-protection.json)) targets every tag and forbids updating or deleting one. It does not restrict tag creation, which the merge workflow needs.

A file in the repository is not proof of what GitHub enforces. Query the live state before reporting it:

```sh
gh api repos/Okamishimo/csv-table-editor/rulesets
gh api repos/Okamishimo/csv-table-editor/rules/branches/main
```

To change a ruleset, edit its file and update the existing ruleset by ID rather than creating another one, which would duplicate it. Do not add classic branch protection alongside the ruleset. From the repository root:

```sh
gh api --method PUT repos/Okamishimo/csv-table-editor/rulesets/<ruleset-id> --input .github/main-protection.json
gh api --method PUT repos/Okamishimo/csv-table-editor/rulesets/<ruleset-id> --input .github/tag-protection.json
```

Use `--method POST repos/Okamishimo/csv-table-editor/rulesets` only when the ruleset list shows that one is missing. A required check must have run on the repository before it can be required, so a renamed `PR policy` or `Verify` job has to reach main before the ruleset names it.

GitHub tag rules have no native "commit belongs to main" condition. The hooks can be bypassed and release CI rejects an invalid tag **after** it reaches GitHub. To prohibit all manual tag creation server-side, configure a dedicated GitHub App as the only bypass actor for a tag-creation restriction and let that App's workflow validate main ancestry before creating tags. This extra App setup is not enabled by the supplied configurations.

Existing assets are never overwritten. Duplicate tag/release events skip a release that already has both assets. If both assets uploaded but the final publication failed, a retry using the corrected release script publishes the existing draft and skips packaging. Drafts are resolved by their pending tag through GraphQL because the REST tag endpoint only returns published releases. A partially uploaded release fails safely: retain the existing asset, use a new patch version/tag for a fresh build, and leave the incomplete release as a draft. Do not move or reuse a published tag. Every release keeps one canonical `csv-table-editor-<version>-enhanced.vsix`.

For local packaging after tests pass, use the installed VSCE binary with the same canonical filename (on Windows, `node_modules\\.bin\\vsce.cmd`). Never overwrite an existing version. GitHub Actions verifies runtime modules, the vendor bundle, manifest, documentation, license, and media are present and generates SHA-256.

Authentication and installation references: [VS Code SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage), [GitHub release asset permissions](https://docs.github.com/en/rest/releases/assets), [VS Code CLI](https://code.visualstudio.com/docs/configure/command-line).
