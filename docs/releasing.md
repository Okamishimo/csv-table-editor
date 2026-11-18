# Maintainer release guide

[Back to readme](../readme.md) · [Canonical release rules](../.github/release-rules.md)

## Development

- Work on a topic branch; all changes to `main` go through a PR.
- Use `Feature:`, `Fix:` or documentation-only `Docs:` titles. These do not change versions or publish releases.
- Run `npm ci` after checkout or lockfile changes. Use `npm run build`, not the obsolete compile task.
- Pre-commit verifies the staged files with `npm run verify`. Do not bypass the hook or repeat that pass immediately before committing.
- Update documentation only when an existing instruction becomes inaccurate. Keep changelog entries limited to meaningful user-facing changes.

## Release

1. Create a release branch from current `main` in this repository.
2. Run `npm version patch --no-git-tag-version`; the manifest and both lockfile version fields must match an unused version.
3. Move relevant user-facing notes from `[Unreleased]` to a dated version entry.
4. Commit, push and open **Release vX.Y.Z: description** against `main`.
5. The maintainer merges after required checks pass and conversations are resolved.

GitHub Actions then tags the exact merge commit, builds and tests, packages one `csv-table-editor-<version>-enhanced.vsix`, verifies its contents, generates SHA-256 and publishes the GitHub Release. No Marketplace token is needed. Packaging runs on GitHub unless a local artifact is explicitly requested.

Release PRs must originate in this repository; ordinary contributions may come from forks. The merged-release workflow uses guarded `pull_request: closed`, and all jobs use Node 26 on `ubuntu-26.04`.

## Existing releases

Never move tags or overwrite release assets. A draft with both verified assets can be finished without repackaging. A partial upload requires a new version. See the [release rules](../.github/release-rules.md) and `AGENTS.md` for recovery details.

## Dependency updates

Dependabot opens grouped npm and Actions PRs on weekdays at 06:00 Asia/Tokyo. npm major upgrades are manual. Review requests are defined in [CODEOWNERS](../.github/CODEOWNERS). Configuration changes take effect after merging into `main`.
