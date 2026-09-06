---
name: release-preflight
description: Check csv-table-editor release readiness, including versions, changes, tests, Release PRs, tags, and GitHub Actions. Use for pre-release checks, preparing a new version or release PR, or deciding whether a release is ready. Do not use for ordinary feature development.
---

# Release Preflight

This is the Codex entry point. Read and follow the
[shared release-preflight skill](../../../.claude/skills/release-preflight/SKILL.md).
Maintain the full procedure only there; Claude Code uses that same file.

Resolve the shared file within this entry point's repository, independently of
the caller's current subdirectory. If it is missing, report an incomplete skill
installation rather than claiming the release checks passed from memory.
