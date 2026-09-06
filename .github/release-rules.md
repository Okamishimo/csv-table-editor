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
- Release PR titles must start with `Release vX.Y.Z: ` followed by a description, for
  example `Release v0.0.16: protect the release workflow`.
- Use stable semantic versions without zero padding, prerelease identifiers, or
  build metadata.
- The title version must exactly match `package.json`'s `version`, the root
  `version` in `package-lock.json`, and its `packages[""].version`.
- The version must exceed the PR's main base version and have no existing tag.
- Before merging, `PR policy` and `Verify` must pass, the branch must be up to
  date with main, and all conversations must be resolved. This single-maintainer
  repository does not require an additional reviewer's approval.
- Follow these collaboration rules even when the GitHub plan cannot enforce them.

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
- All other paths require a Release PR, including source code, tests, scripts,
  workflows, manifests, lockfiles, hooks, configuration, and media. A `.md`
  extension alone does not qualify a file in a code directory as documentation.
- Additions, modifications, deletions, and both sides of renames are checked.
  Moving code into a Markdown path does not conceal the deleted code path.
  Symlinks and executable files are rejected even at allowed documentation paths.
- If a Docs PR includes any non-documentation change, `PR policy` fails. Do not
  widen the allowlist just to pass the check: use a Release PR or separate the
  changes into correctly scoped PRs.
- Both PR types retain `PR policy` and `Verify` checks. For Docs PRs, `Verify`
  confirms the successful quick checks; for Release PRs, it runs full verification.
  Title edits and new commits rerun classification and validation.
- The local pre-commit hook still runs full staged-content verification for all
  commits. The quick-check exception applies to documentation PR CI only.

## Local checks before committing

- Run `npm ci` after cloning to install `.githooks` automatically. Existing
  checkouts can run `npm run hooks:install`.
- Pre-commit exports an isolated copy of staged contents and runs `npm run verify`
  using locally installed dependencies. Keep dependencies current with `npm ci`.
- Verification includes distribution patching, JavaScript syntax checks, the
  full test suite, and patch idempotency. Any failure blocks the commit.
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
Topic branch -> staged verification -> commit -> push -> Release vX.Y.Z: description PR
-> PR policy / Verify pass -> merge into main
-> create vX.Y.Z on the PR's exact merge commit
-> call the private release workflow -> package, verify, publish
```

- [merge-release.yml](workflows/merge-release.yml) handles merged PRs into main.
  Closing an unmerged PR does not create a tag. A merged Docs PR reports that
  publication is skipped and never calls the tag API or release workflow.
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

On 2026-09-06, API inspection and an attempt to apply main protection returned
HTTP 403, requiring GitHub Pro for this private repository. This is a dated
observation, not permanent state; query again when reporting current status.
Keep the repository private rather than making it public to enable protections.

- [main-protection.json](main-protection.json) is a prepared configuration requiring
  PRs, GitHub Actions checks `PR policy` and `Verify`, an up-to-date branch, and
  resolved conversations. It includes administrators and forbids main force
  pushes and deletion.
- [tag-protection.json](tag-protection.json) is a prepared configuration forbidding
  tag updates and deletion. It does not restrict tag creation.
- Configuration files do not prove server enforcement. Once the plan supports
  protection, ensure the workflows are deployed and their checks have run, then
  follow the [README setup](../readme.md#server-protection-setup) and query the
  resulting state. Do not create duplicate rulesets.
- GitHub tag rules have no native main-ancestry condition. Hooks can be bypassed;
  release CI rejects publication after a tag reaches GitHub. Do not describe
  these checks as preventing all invalid remote tags.
- Strict server-side tag creation control additionally requires a dedicated
  GitHub App as the sole bypass actor for a tag-creation restriction, with its
  workflow validating ancestry. The supplied configuration does not set up that App.
- Distinguish automatic tagging after PR merges from enforced main/tag protection.
  Plan or configuration limits on protection do not prevent the automation itself.

## Completion reporting

State what remains local, what is committed/pushed, and what GitHub has actually
verified. After publication, confirm the workflow conclusion, published Release
state, asset names and sizes, and SHA-256. A created tag or successful asset upload
alone does not prove publication is complete.
