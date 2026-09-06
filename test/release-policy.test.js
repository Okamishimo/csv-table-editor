"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { prKind, checkPr, validateTitle, assertOnMain, ensureTagTarget, tagMergedPr, main } = require("../scripts/release-policy");
const { checkPush } = require("../scripts/pre-push");

const manifest = { version: "0.0.16" };
const lock = { ...manifest, packages: { "": manifest } };

test("release titles require a stable matching new version and description", () => {
  assert.equal(validateTitle("Release v0.0.16: release policy", manifest, lock, { version: "0.0.15" }), "v0.0.16");
  for (const title of ["release v0.0.16: lower case", "Release 0.0.16: no v", "Release v0.0.016: padding",
    "Release v0.0.16-beta: preview", "Release v0.0.16:", "Release v0.0.16: ", "Release v0.0.16: x\ny",
    "Prefix Release v0.0.16: x", "Release v0.0.17: mismatch"]) {
    assert.throws(() => validateTitle(title, manifest, lock));
  }
  for (const broken of [{ ...lock, version: "0.0.15" }, { ...lock, packages: { "": { version: "0.0.15" } } }]) {
    assert.throws(() => validateTitle("Release v0.0.16: x", manifest, broken), /must match/);
  }
  for (const version of ["0.0.16", "0.0.17", "1.0.0"]) {
    assert.throws(() => validateTitle("Release v0.0.16: x", manifest, lock, { version }), /increment/);
  }
});

test("tag ancestry checks peel annotated tags, allow main ancestors and reject feature-only commits", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csv-tag-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-b", "main"]);
  git(["commit", "--allow-empty", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]);
  git(["tag", "-a", "v0.0.1", "-m", "annotated"]);
  git(["commit", "--allow-empty", "-m", "main"]);
  const head = git(["rev-parse", "HEAD"]);
  git(["update-ref", "refs/remotes/origin/main", head]);
  git(["switch", "-c", "feature"]);
  git(["commit", "--allow-empty", "-m", "feature"]);
  const feature = git(["rev-parse", "HEAD"]);
  assert.equal(assertOnMain("refs/tags/v0.0.1", git), base);
  assert.equal(assertOnMain(head, git), head);
  assert.throws(() => assertOnMain(feature, git), /only point to commits/);
  assert.throws(() => assertOnMain("HEAD^{tree}", git));
  assert.equal(ensureTagTarget("v0.0.1", base, git), true);
  assert.equal(ensureTagTarget("v0.0.2", head, git), false);
  assert.throws(() => ensureTagTarget("v0.0.1", head, git), /never move a tag/);
  assert.throws(() => ensureTagTarget("v0.0.2", head, () => { throw Object.assign(new Error("access failed"), { status: 128 }); }), /access failed/);
});

test("pre-push blocks direct main changes, checks every tag against fresh remote main and fails closed", () => {
  const zero = "0".repeat(40);
  const sha = "a".repeat(40);
  const calls = [];
  const git = (args) => { calls.push(args); return sha; };
  assert.throws(() => checkPush(`refs/heads/topic ${sha} refs/heads/main ${zero}`, "origin", git), /Docs or Release PR/);
  assert.equal(calls.length, 0);
  checkPush(`refs/heads/topic ${sha} refs/heads/topic ${zero}`, "origin", git);
  assert.equal(calls.length, 0);
  const tag = `refs/tags/v0.0.16 ${sha} refs/tags/v0.0.16 ${zero}`;
  checkPush(`${tag}\nrefs/tags/test ${sha} refs/tags/test ${zero}\n`, "origin", git);
  assert.deepEqual(calls[0], ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  assert.equal(calls.filter((args) => args[0] === "merge-base").length, 2);
  assert.throws(() => checkPush(tag, "other", git), /through origin/);
  assert.throws(() => checkPush(`refs/tags/x ${sha} refs/tags/x ${sha}`, "origin", git), /never be deleted or replaced/);
  assert.throws(() => checkPush(`(delete) ${zero} refs/tags/x ${sha}`, "origin", git), /never be deleted or replaced/);
  assert.throws(() => checkPush(tag, "origin", () => { throw new Error("offline"); }), /offline/);
  assert.throws(() => checkPush(tag, "origin", (args) => {
    if (args[0] === "merge-base") throw new Error("not merged");
    return sha;
  }), /only point to commits/);
});

test("automatic tagging rejects unmerged PRs, other branches and repositories before GitHub access", (t) => {
  const oldEvent = process.env.GITHUB_EVENT_PATH;
  const oldRepo = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_EVENT_PATH = "mock-event";
  process.env.GITHUB_REPOSITORY = "Okamishimo/csv-table-editor";
  t.after(() => {
    for (const [key, value] of [["GITHUB_EVENT_PATH", oldEvent], ["GITHUB_REPOSITORY", oldRepo]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const valid = { merged: true, base: { ref: "main", repo: { full_name: process.env.GITHUB_REPOSITORY } }, merge_commit_sha: "a".repeat(40) };
  for (const pr of [{ ...valid, merged: false }, { ...valid, base: { ...valid.base, ref: "feature" } },
    { ...valid, base: { ref: "main", repo: { full_name: "other/repo" } } }, { ...valid, merge_commit_sha: "--bad" }]) {
    const mocked = t.mock.method(fs, "readFileSync", () => JSON.stringify({ pull_request: pr }));
    assert.throws(() => main("tag"), /Only a merged PR/);
    mocked.mock.restore();
  }
});

test("a merged PR tags its exact commit once, retries safely and never tags a later main commit", () => {
  const repository = "Okamishimo/csv-table-editor";
  const commit = "a".repeat(40);
  const later = "b".repeat(40);
  const pr = { merged: true, base: { ref: "main", repo: { full_name: repository } },
    title: "Release v0.0.16: release policy", merge_commit_sha: commit };
  const mutations = [];
  let existing = null;
  let onMain = true;
  const git = (args) => {
    if (args[0] === "show") {
      assert.ok(args[1].startsWith(`${commit}:`));
      return JSON.stringify(args[1].endsWith(":package.json") ? manifest : lock);
    }
    if (args[0] === "merge-base") {
      assert.equal(args[2], commit);
      if (!onMain) throw new Error("not merged");
      return "";
    }
    if (args.includes(`refs/tags/v0.0.16`)) {
      if (existing) return existing;
      throw Object.assign(new Error("missing"), { status: 1 });
    }
    if (args.includes("refs/tags/v0.0.16^{commit}")) return existing;
    assert.equal(args.at(-1), `${commit}^{commit}`);
    return commit;
  };
  const create = (tag, target) => { mutations.push({ tag, target }); existing = target; };
  assert.deepEqual(tagMergedPr(pr, repository, git, create), { kind: "release", tag: "v0.0.16", commit });
  tagMergedPr(pr, repository, git, create);
  assert.deepEqual(mutations, [{ tag: "v0.0.16", target: commit }]);
  existing = later;
  assert.throws(() => tagMergedPr(pr, repository, git, create), /never move a tag/);
  existing = null;
  onMain = false;
  assert.throws(() => tagMergedPr(pr, repository, git, create), /only point to commits/);
  assert.equal(mutations.length, 1);
});

test("PR types require exact Docs or Release prefixes and a nonempty single-line description", () => {
  assert.equal(prKind("Docs: clarify the release guide"), "docs");
  assert.equal(prKind("Release v0.0.16: code changes"), "release");
  for (const title of ["Docs:", "Docs: ", "docs: x", "Docs:x", "Docs: x\ncode", "Docs: x\r", "Documentation: x", "Release v0.0.016: x"]) {
    assert.throws(() => prKind(title), /PR title must/);
  }
});

test("merged documentation PRs make no tag API call or version lookup, including on retry", () => {
  const repository = "Okamishimo/csv-table-editor";
  const commit = "a".repeat(40);
  const pr = { merged: true, base: { ref: "main", repo: { full_name: repository } },
    title: "Docs: explain the workflow", merge_commit_sha: commit };
  const git = (args) => {
    assert.ok(["rev-parse", "merge-base"].includes(args[0]), "Docs merges must not read versions or tags");
    return commit;
  };
  for (let retry = 0; retry < 2; retry++) {
    assert.deepEqual(tagMergedPr(pr, repository, git, () => assert.fail("Docs must never create a tag")),
      { kind: "docs", tag: "", commit });
  }
});

test("release PR checks still require a newer matching version and an unused tag", () => {
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  let tagExists = false;
  const git = (args) => {
    if (args[0] === "rev-parse") {
      if (tagExists) return head;
      throw Object.assign(new Error("missing tag"), { status: 1 });
    }
    assert.equal(args[0], "show");
    if (args[1] === `${base}:package.json`) return JSON.stringify({ version: "0.0.15" });
    return JSON.stringify(args[1] === `${head}:package.json` ? manifest : lock);
  };
  assert.deepEqual(checkPr("Release v0.0.16: x", base, head, git), { kind: "release", tag: "v0.0.16" });
  tagExists = true;
  assert.throws(() => checkPr("Release v0.0.16: x", base, head, git), /already has a tag/);
  assert.throws(() => checkPr("Release v0.0.17: x", base, head, git), /must match/);
});

test("workflow wiring validates ancestry before publication and calls release explicitly after tagging", () => {
  const read = (name) => fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", name), "utf8");
  const release = read("private-release.yml");
  assert.match(release, /workflow_call:/);
  assert.match(release, /fetch-depth: 0/);
  assert.ok(release.indexOf("release-policy.js check-tag") < release.indexOf("private-release.js prepare"));
  const merge = read("merge-release.yml");
  assert.match(merge, /if: github.event.pull_request.merged == true/);
  assert.match(merge, /ref: \$\{\{ github.event.pull_request.merge_commit_sha \}\}/);
  assert.match(merge, /uses: \.\/.github\/workflows\/private-release.yml/);
  assert.match(merge, /needs: tag/);
  assert.match(merge, /if: needs.tag.outputs.kind == 'release'/);
  assert.match(merge, /kind: \$\{\{ steps.tag.outputs.kind \}\}/);
  assert.match(read("pull-request.yml"), /reopened, edited/);
  assert.match(read("pull-request.yml"), /run: npm run verify/);
  const verify = read("pull-request.yml").split("  verify:\n")[1];
  assert.match(verify, /needs: policy/);
  assert.match(verify, /if: needs.policy.outputs.kind == 'docs'/);
  for (const step of verify.split(/\n      - /).slice(1)) {
    assert.match(step, /if: needs.policy.outputs.kind == '(?:docs|release)'/);
    if (/npm ci|npm run verify|actions\//.test(step)) assert.match(step, /if: needs.policy.outputs.kind == 'release'/);
  }
});
