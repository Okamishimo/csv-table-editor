"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { isDocumentation, checkDocumentation } = require("../scripts/docs-policy");
const { checkPr } = require("../scripts/release-policy");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csv-docs-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (args, input) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
  { cwd: root, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const commit = () => { git(["add", "."]); git(["commit", "-m", "test changes"]); return git(["rev-parse", "HEAD"]); };
  git(["init", "-b", "main"]);
  write("readme.md", "# Guide\n");
  write("src/example.js", "module.exports = 1;\n");
  const base = commit();
  git(["switch", "-c", "topic"]);
  return { root, git, write, commit, base };
}

test("documentation allowlist excludes code, configuration and Markdown outside document locations", () => {
  for (const file of ["readme.md", "changelog.md", "AGENTS.md", "CLAUDE.md", "docs/usage.md", "docs/nested/a b.md",
    ".github/release-rules.md", ".claude/skills/release-preflight/SKILL.md", ".agents/skills/release-preflight/SKILL.md",
    ".claude/skills/release-preflight/references/usage.md"]) assert.equal(isDocumentation(file), true, file);
  for (const file of ["src/file.js", "src/guide.md", "test/guide.md", "scripts/guide.md", "dist/extension.js",
    "package.json", "package-lock.json", ".github/workflows/pr.yml", ".github/main-protection.json", ".githooks/pre-commit",
    ".vscodeignore", "docs/code.js", "docs/page.mdx", ".claude/settings.json", ".agents/skills/x/scripts/check.js",
    "docs/../src/guide.md", "docs//guide.md", "media/icon.png"]) assert.equal(isDocumentation(file), false, file);
});

test("Docs PR checks additions, edits and deletions without needing a manifest, dependencies or a version bump", (t) => {
  const { git, write, commit, base, root } = fixture(t);
  write("readme.md", "# Updated guide\n");
  write("docs/a file.md", "# New documentation\n");
  const head = commit();
  assert.deepEqual(checkPr("Docs: update guides", base, head, git), { kind: "docs", files: 2 });
  fs.rmSync(path.join(root, "readme.md"));
  const deletion = commit();
  assert.equal(checkDocumentation(head, deletion, git), 1);
});

test("Docs PR fails on mixed code changes, code renamed to Markdown, and config changes", (t) => {
  const { git, write, commit, base } = fixture(t);
  write("readme.md", "# Updated guide\n");
  write("src/example.js", "module.exports = 2;\n");
  assert.throws(() => checkPr("Docs: misleading title", base, commit(), git), /src\/example.js/);
  git(["switch", "-C", "renamed", base]);
  write("docs/placeholder.md", "# Docs\n");
  git(["mv", "src/example.js", "docs/example.md"]);
  assert.throws(() => checkPr("Docs: rename", base, commit(), git), /src\/example.js/);
  git(["switch", "-C", "configuration", base]);
  write("package.json", '{"version":"0.0.16"}\n');
  assert.throws(() => checkPr("Docs: bump version", base, commit(), git), /package.json/);
});

test("Docs PR rejects symlink and executable file modes without relying on OS symlink permissions", (t) => {
  const { git, base } = fixture(t);
  const blob = git(["hash-object", "-w", "--stdin"], "src/example.js");
  for (const mode of ["120000", "100755"]) {
    git(["update-index", "--cacheinfo", `${mode},${blob},readme.md`]);
    git(["commit", "-m", `mode ${mode}`]);
    assert.throws(() => checkPr("Docs: change mode", base, git(["rev-parse", "HEAD"]), git), /non-regular files/);
  }
});

test("quick checks reject whitespace errors, empty diffs and invalid revisions", (t) => {
  const { git, write, commit, base } = fixture(t);
  write("readme.md", "# Guide   \n");
  assert.throws(() => checkPr("Docs: whitespace", base, commit(), git), /whitespace check failed/);
  assert.throws(() => checkPr("Docs: empty", base, base, git), /nonempty documentation diff/);
  assert.throws(() => checkPr("Docs: x", "--bad", base, git), /Missing PR base or head/);
});

test("the PR diff excludes unrelated code committed to main after the topic branched", (t) => {
  const { git, write, commit } = fixture(t);
  write("readme.md", "# Topic documentation\n");
  const head = commit();
  git(["switch", "main"]);
  write("src/example.js", "module.exports = 3;\n");
  const newerMain = commit();
  assert.deepEqual(checkPr("Docs: topic documentation", newerMain, head, git), { kind: "docs", files: 1 });
});
