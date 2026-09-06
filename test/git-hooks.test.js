"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { verifyStaged } = require("../scripts/pre-commit");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csv-hook-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init"]);
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "extension.js"), "staged bundle");
  // Stand in for npm's CLI without recursively running this test suite.
  const npm = path.join(root, "node_modules", "fake-npm.js");
  fs.writeFileSync(npm, `const fs = require('node:fs');
    if (process.argv.slice(2).join(' ') !== 'run verify') process.exit(9);
    if (fs.readFileSync('test-result', 'utf8') !== 'pass') process.exit(1);
    if (fs.existsSync('rebuild')) fs.writeFileSync('dist/extension.js', 'rebuilt');`);
  const result = path.join(root, "test-result");
  fs.writeFileSync(result, "pass");
  git(["add", "dist", "test-result"]);
  return { root, git, npm, result };
}

test("pre-commit tests the index and leaves unstaged content and staging untouched", (t) => {
  const { root, git, npm, result } = fixture(t);
  fs.writeFileSync(result, "unstaged failure");
  const index = git(["ls-files", "--stage"]);
  verifyStaged(root, npm);
  assert.equal(fs.readFileSync(result, "utf8"), "unstaged failure");
  assert.deepEqual(git(["ls-files", "--stage"]), index);
  git(["add", "test-result"]);
  fs.writeFileSync(result, "pass");
  assert.throws(() => verifyStaged(root, npm));
  assert.equal(git(["show", ":test-result"]).toString(), "unstaged failure");
  assert.equal(fs.readFileSync(result, "utf8"), "pass");
});

test("pre-commit rejects an unstaged generated bundle without modifying the real bundle", (t) => {
  const { root, git, npm } = fixture(t);
  fs.writeFileSync(path.join(root, "rebuild"), "yes");
  git(["add", "rebuild"]);
  assert.throws(() => verifyStaged(root, npm), /stage dist\/extension.js/);
  assert.equal(fs.readFileSync(path.join(root, "dist", "extension.js"), "utf8"), "staged bundle");
});

test("pre-commit fails with an actionable message when dependencies or npm are missing", (t) => {
  const { root, npm } = fixture(t);
  assert.throws(() => verifyStaged(root, ""), /npm run precommit/);
  fs.rmSync(path.join(root, "node_modules"), { recursive: true });
  assert.throws(() => verifyStaged(root, npm), /npm ci/);
});
