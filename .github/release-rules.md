# Commit, PR, Tag, and Release Rules

These rules apply to `Okamishimo/csv-table-editor`. Read this file for relevant
tasks as directed by the root [AGENTS.md](../AGENTS.md). This is the central Git
collaboration and release policy; AGENTS.md still defines editing, testing, and
package safety requirements.

## When to read

Read this file before:

- Creating or switching development branches, committing, or pushing.
- Creating, editing, reviewing, or merging a PR.
- Changing versions, tagging, packaging, publishing, or recovering a release.
- Changing Git hooks, GitHub Actions, or main/tag protection settings.
- Answering whether this project's PR rules, automatic tagging, or GitHub
  protections are enabled.

Ordinary editor development does not require repeatedly loading these rules;
read them when entering one of the workflows above. This file does not itself
authorize commits, pushes, merges, or publication. Follow the current task scope.

## Main and pull requests

- Make changes on topic branches and merge into `main` through a PR.
- Never push directly to `main`; administrators follow the same rule.
- A PR is one of four kinds, told apart by its title alone:
  `Docs: description`, `Feature: description`, `Fix: description`, and
  `Release vX.Y.Z: description`. Every prefix is case-sensitive, and every
  description must be nonempty and on one line.
- Only a Release PR tags and publishes. Feature and Fix work merges into main
  and waits there; a Release PR later publishes whatever has accumulated.
- Release PR titles must start with `Release vX.Y.Z: ` followed by a description, for
  example `Release v0.0.16: protect the release workflow`.
- Use stable semantic versions without zero padding, prerelease identifiers, or
  build metadata.
- The title version must exactly match `package.json`'s `version`, the root
  `version` in `package-lock.json`, and its `packages[""].version`.
- The version must exceed the PR's main base version and have no existing tag.
- A Release PR must carry the bump itself: `PR policy` refuses one whose
  `package.json` and `package-lock.json` versions match its base. That is what
  separates a release from the Feature and Fix PRs it publishes.
- Before merging, `PR policy` and `Verify` must pass, the branch must be up to
  date with main, and all conversations must be resolved. This single-maintainer
  repository does not require an additional reviewer's approval.
- GitHub enforces the PR requirement, required checks, up-to-date branch and
  resolved conversations; see [Server protection](#server-protection-and-known-limits).
  Follow these collaboration rules regardless of what the server enforces.

## Feature and Fix PRs

- Use `Feature: description` for new behavior and `Fix: description` for
  corrections, for example `Fix: stop the preview flickering`. Both carry code,
  configuration, workflows, tests, and any documentation that belongs with them.
- Both run the full `Verify` job, exactly as a Release PR does. Only Docs PRs
  take the quick-check path.
- Neither changes a version. `PR policy` refuses a Feature or Fix PR that moves
  `package.json` or `package-lock.json`: a bump merged without a release would
  leave main claiming a version no tag and no VSIX ever carried.
- Merging one creates no tag, VSIX, or GitHub Release. It merges and stops.
- Choose between them by what the change does, not by its size. When a PR does
  both, `Feature:` is the honest prefix.

## Documentation PRs

- Use `Docs: description`, for example `Docs: clarify the release guide`, for
  documentation-only changes. The prefix is case-sensitive and the description
  must be nonempty and on one line.
- Docs PRs do not change versions and never create a tag, VSIX, or GitHub Release
  when merged. Only Release PRs enter the automatic publication path below.
- Quick checks validate the entire PR diff against `scripts/docs-policy.js` and
  run `git diff --check`. They do not install dependencies or run the full suite.
- Allowed files are regular, non-executable Markdown files at `readme.md`,
  `changelog.md`, `AGENTS.md`, `CLAUDE.md`, `.github/release-rules.md`, under `docs/`,
  or `SKILL.md` and `references/**/*.md` inside named skills under `.agents/skills/`
  and `.claude/skills/`. Skill names use lowercase letters, digits, and hyphens.
- All other paths require a Feature, Fix, or Release PR, including source code,
  tests, scripts, workflows, manifests, lockfiles, hooks, configuration, and
  media. A `.md` extension alone does not qualify a file in a code directory as
  documentation.
- Additions, modifications, deletions, and both sides of renames are checked.
  Moving code into a Markdown path does not conceal the deleted code path.
  Symlinks and executable files are rejected even at allowed documentation paths.
- If a Docs PR includes any non-documentation change, `PR policy` fails. Do not
  widen the allowlist just to pass the check: use a Feature, Fix, or Release PR,
  or separate the changes into correctly scoped PRs.
- Every kind retains `PR policy` and `Verify` checks. For Docs PRs, `Verify`
  confirms the successful quick checks; for every other kind it runs full
  verification. Title edits and new commits rerun classification and validation.
- The local pre-commit hook still runs full staged-content verification for all
  commits. The quick-check exception applies to documentation PR CI only.

## Local checks before committing

- Run `npm ci` after cloning to install `.githooks` automatically. Existing
  checkouts can run `npm run hooks:install`.
- Pre-commit exports an isolated copy of staged contents and runs `npm run verify`
  using locally installed dependencies. Keep dependencies current with `npm ci`.
- Verification includes distribution patching, JavaScript syntax checks, the
  full test suite, and patch idempotency. Any failure blocks the commit.
- The hook is that verification pass. Do not run `npm run verify` again just
  before committing: it checks the same contents the hook is about to check,
  and a commit cannot slip past a failure. Run tests while developing, as often
  as the work needs, then commit and let the hook have the last word.
- Unstaged fixes must not hide failures in the staged contents.
- If the build changes staged `dist/extension.js`, run `npm run build`, stage the
  generated change, and retry. Never hand-edit the vendor bundle.
- Do not bypass checks with `--no-verify`, a different hooks path, or other means.
- Preserve the working tree and index; do not automatically stage unrelated work.

## Tags must point to commits on main

- A tag's target commit must already be reachable from remote `origin/main`.
  Main's ancestors are allowed; a tag need not point to the latest main HEAD.
- Do not create release tags on feature-branch commits that have not merged
  into main.
- Never delete, overwrite, or move tags. Changed contents require a new version.
- Local pre-push blocks direct main pushes. Before tag pushes it fetches remote
  main, checks every target's ancestry, and rejects tag deletion or replacement.
- Release CI checks main ancestry again before preparing assets, packaging, or
  publication.

## Automatic tagging after a PR merge

**A Release PR merged into main can automatically create a tag. This automation does
not require GitHub Pro.**

The normal flow is:

```text
Topic branch -> staged verification -> commit -> push
-> Docs / Feature / Fix PR -> PR policy / Verify pass -> merge into main -> stop
-> Release vX.Y.Z: description PR (the version bump itself)
-> PR policy / Verify pass -> merge into main
-> create vX.Y.Z on the PR's exact merge commit
-> call the private release workflow -> package, verify, publish
```

- [merge-release.yml](workflows/merge-release.yml) handles merged PRs into main.
  Closing an unmerged PR does not create a tag. A merged Docs, Feature, or Fix PR
  reports that publication is skipped and never calls the tag API or release
  workflow, nor does it read a version.
- The repository setting deletes a merged PR's head branch. No workflow does it,
  and a PR closed without merging keeps its branch.
- The tag targets the PR's `merge_commit_sha`, not a later main HEAD at workflow
  execution time. Validate title, manifest, lockfile, and main ancestry again.
- On retry, reuse an existing tag only when it points to that same commit.
  A different target is an error; never force-update it.
- After creating a tag with `GITHUB_TOKEN`, directly call the reusable
  [private-release.yml](workflows/private-release.yml). Do not rely on that
  token's tag push to trigger another workflow or introduce a PAT for this.
- Workflows must be committed and reach GitHub's main before reporting them as
  deployed. Local files or passing unit tests do not prove a successful Actions run.
- Never overwrite release tags or assets. Follow AGENTS.md's GitHub Actions
  Publication and Recovery section for retries, complete drafts, and partial uploads.
- Do not create a local VSIX unless packaging was requested. Once configured,
  merging a release PR triggers packaging and publication through the workflow.

## Server protection and known limits

The repository is public, and GitHub enforces protection through two repository
rulesets. While it was private, protection returned HTTP 403 and required
GitHub Pro; that no longer applies. On 2026-09-13 both rulesets were queried
active. This is a dated observation; query again when reporting current status.

- [main-protection.json](main-protection.json) is the `Protect main` ruleset. It
  refuses direct pushes, force pushes and deletion of `main`, so every change
  arrives through a merged PR. Merging requires GitHub Actions checks `PR policy`
  and `Verify`, an up-to-date branch, and resolved conversations. It has no
  bypass actors, so administrators are included.
- [tag-protection.json](tag-protection.json) is the `Immutable tags` ruleset,
  forbidding tag updates and deletion. It does not restrict tag creation.
- Configuration files do not prove server enforcement. Query the rulesets when
  reporting their state, and change them by updating the existing ruleset as the
  [protection setup](../docs/releasing.md#server-protection-setup) describes. Do not
  create duplicate rulesets or add classic branch protection alongside them.
- GitHub tag rules have no native main-ancestry condition. Hooks can be bypassed;
  release CI rejects publication after a tag reaches GitHub. Do not describe
  these checks as preventing all invalid remote tags.
- Strict server-side tag creation control additionally requires a dedicated
  GitHub App as the sole bypass actor for a tag-creation restriction, with its
  workflow validating ancestry. The supplied configuration does not set up that App.
- Distinguish automatic tagging after PR merges from enforced main/tag protection.
  Plan or configuration limits on protection do not prevent the automation itself.

## Completion reporting

An agent's work on a release ends when the PR exists. State what remains local,
what is committed and pushed, and confirm the PR was created, giving its number,
title, and base. Then stop: do not wait for, poll, or report `PR policy` and
`Verify`. Those checks are the maintainer's to watch, and polling them only
makes the task run longer without adding anything the maintainer cannot see on
the PR itself.

Merging the PR, the tag its merge creates, the release workflow's run, and the
published Release are the maintainer's to carry out and confirm. Do not merge a
release PR, do not watch the publication workflow, and do not download published
assets to recompute a checksum the workflow has already generated and verified.
