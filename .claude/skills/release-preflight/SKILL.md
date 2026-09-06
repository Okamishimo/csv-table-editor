---
name: release-preflight
description: Check csv-table-editor release readiness, including versions, changes, tests, Release PRs, tags, and GitHub Actions. Use for pre-release checks, preparing a new version or release PR, or deciding whether a release is ready. Do not use for ordinary feature development.
---

# Release Preflight

Shared by Codex and Claude Code in this repository. Produce an evidence-based
readiness assessment and, when requested, prepare reviewable local release changes.
Maintain the procedure only in this file; the Codex entry at
`.agents/skills/release-preflight/SKILL.md` routes here. Keep instructions portable:
avoid client-specific shell interpolation and tool names.

## Load the project rules

Locate the repository root with `git rev-parse --show-toplevel` and run commands
there. Read [AGENTS.md](../../../AGENTS.md) and the
[release rules](../../../.github/release-rules.md). Inspect current files and
Git/GitHub state; old conversations are not current evidence of versions, test
results, or enabled protection.

Distinguish a check-only request from release preparation or an authorized
publication. For checks, report issues and remedies; for release preparation,
update versions and documentation within the requested scope. Honor existing
authorization without asking again. Invoking this skill alone does not authorize
committing, pushing, creating or merging a PR, tagging, packaging, or publishing.

## Inspect the changes and target

- Inspect `git status --short`, the current branch, remotes, and staged/unstaged
  diffs. Obtain current remote main and tag state. Preserve user changes; do not
  reset, stash, or stage unrelated work.
- Confirm the repository is `Okamishimo/csv-table-editor` and the destination is
  its private GitHub Releases. Do not publish to the public Marketplace or change
  repository visibility.
- When preparing changes from main, work on a topic branch. Never push directly
  to main.
- Identify the full intended release scope, including earlier uncommitted work.
  Do not split packages by author. Preserve changes whose intended scope is
  unclear rather than committing them on the user's behalf.

## Select the PR type first

- Classify the actual changed files using `scripts/docs-policy.js` and the
  release rules. Documentation-only work may use `Docs: description`; code,
  configuration, workflow, or mixed changes require a Release PR.
- For an existing or proposed Docs PR, run `node scripts/release-policy.js pr`
  with `PR_TITLE`, `PR_BASE_SHA`, and `PR_HEAD_SHA` provided as environment data.
  Use the actual commits and title, not untrusted title text interpolated into
  shell code. Quick validation checks the full PR file scope and whitespace.
- If documentation validation fails, report the offending files. Do not waive
  the failure or expand the allowlist to admit code. Prepare a Release PR or
  separate the changes when that is within the user's requested scope.
- For a valid Docs PR, skip release version changes, tag/artifact checks, and
  release packaging. Its CI needs only the quick checks, and merging must not
  tag or publish. Report readiness for a documentation PR, not for a release.
  The local pre-commit hook still requires full staged verification if committing.
- Continue through the release-specific steps below only for a Release PR.

## Check versions, documentation, and existing artifacts

- Compare `package.json`, both root version fields in `package-lock.json`, and
  remote main. The target must be a newer stable version, all three fields must
  agree, and the corresponding tag must not exist.
- Prepare a candidate title matching `Release vX.Y.Z: description`. If a PR
  already exists, inspect its actual title, base, and head rather than only a
  proposed local title. Apply the rules in `scripts/release-policy.js`.
- Do not run `npm version` for a check-only request. When asked to prepare a new
  version, update the manifest and lockfile together without automatically
  committing or tagging.
- Check that `readme.md` reflects user-visible changes and `changelog.md` is
  complete. Keep ordinary pending changes under `[Unreleased]`; organize a dated
  version entry when explicitly preparing that release, retaining `[Unreleased]`.
- Check for an existing tag, published/draft Release, and local canonical VSIX
  for the target version. Never overwrite or move existing artifacts; a changed
  build needs a new version. For failed-release recovery, first read AGENTS.md's
  recovery instructions and inspect asset completeness. Do not immediately
  repackage or rerun an old tag.
- Create no local VSIX unless packaging was explicitly requested. When it was,
  follow AGENTS.md's verification, filename, contents, size, and SHA-256 rules.

## Run the required verification

- Ensure installed dependencies match the lockfile; run `npm ci` when needed.
  Inspect `core.hooksPath` and the pre-commit/pre-push hooks. Use the project's
  installation procedure where needed, preserving existing custom hooks and
  never bypassing checks.
- When the changes are being committed, the pre-commit hook runs `npm run verify`
  against the staged contents; take its output as the verification result rather
  than running the same pass first. Run it directly only when nothing is being
  committed. It covers the build, syntax checks, full test suite, and patch
  idempotency. Do not run the obsolete compile task.
- Inspect the build diff and run `git diff --check`. If the build updates the
  distribution, verify it came from the patch script and include it in the
  intended changes. Do not describe unstaged output as committed.
- Distinguish working-tree verification from staged verification. At commit
  time, pre-commit verifies a staged snapshot again. Failed or unavailable tests,
  or contents that changed during verification, cannot be reported as passing.
- Reuse successful verification of identical contents when evidence is available
  from the current task. Rerun only after relevant changes, failures, or unresolved
  concerns; do not repeat identical checks without a reason.

## Check the PR and automatic release path

- Inspect `PR policy` and `Verify` in `.github/workflows/pull-request.yml`, and
  the call from `merge-release.yml` to `private-release.yml`.
- Distinguish workflows that exist locally, on a topic branch, on main, or in a
  successful Actions run. For an existing PR, inspect checks for its latest head,
  unresolved conversations, and whether it is behind main. Do not report it as
  merge-ready before the required checks pass.
- A normal release starts after the PR merges into main: tag that PR's exact
  merge commit, then call the release workflow directly. Do not preemptively
  tag an unmerged feature branch.
- A tag created with `GITHUB_TOKEN` does not trigger another push workflow.
  Preserve the direct workflow call; this behavior does not require an extra PAT.
- Verify server protection through read-only APIs when reporting its current
  state. A plan or permission rejection means disabled or unverified protection,
  not that tagging after a PR merge is impossible. Do not upgrade plans or change
  protection settings just to make preflight pass.
- When PR creation is already authorized, finish versions, the description, and
  verification before submitting it within that authorization. For a check-only
  request, provide the candidate title and next steps without submitting anything.

## Report the result

Use a short list or table with Passed, Failed, and Not run states, concrete
evidence, and next steps. Include:

- Target version, PR title, branch, and verification target: working tree, staged
  contents, or commit SHA.
- Version/documentation issues, existing tag or artifact conflicts, and the
  `npm run verify` result.
- Workflow deployment and server protection; label unverified items. Do not
  poll a created PR's checks to report them: creating the PR ends the task.
- Whether the work is ready for PR creation, merge, or publication, and any
  remaining blockers.

Do not equate a passing local preflight with publication. If publication was
separately authorized and completed, also verify the run conclusion, published
Release state, asset names and sizes, and SHA-256.
