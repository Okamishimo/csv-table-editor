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
/** Both required checks, finished and green, on the commit that was merged. */
const checksPassed = () => [{ name: "PR policy", status: "completed", conclusion: "success" },
  { name: "Verify", status: "completed", conclusion: "success" }];
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
  const head = "c".repeat(40);
  const pr = { merged: true, base: { ref: "main", repo: { full_name: repository } },
    head: { sha: head }, title: "Release v0.0.16: release policy", merge_commit_sha: commit };
  const passed = () => [{ name: "PR policy", status: "completed", conclusion: "success" },
    { name: "Verify", status: "completed", conclusion: "success" }];
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
  assert.deepEqual(tagMergedPr(pr, repository, git, create, passed), { kind: "release", tag: "v0.0.16", commit });
  tagMergedPr(pr, repository, git, create, passed);
  assert.deepEqual(mutations, [{ tag: "v0.0.16", target: commit }]);
  existing = later;
  assert.throws(() => tagMergedPr(pr, repository, git, create, passed), /never move a tag/);
  existing = null;
  onMain = false;
  assert.throws(() => tagMergedPr(pr, repository, git, create, passed), /only point to commits/);
  assert.equal(mutations.length, 1);
});

test("a merge that jumped its checks is not tagged, packaged or published", () => {
  const repository = "Okamishimo/csv-table-editor";
  const commit = "a".repeat(40);
  const head = "c".repeat(40);
  const pr = { merged: true, base: { ref: "main", repo: { full_name: repository } },
    head: { sha: head }, title: "Release v0.0.16: release policy", merge_commit_sha: commit };
  const git = (args) => {
    if (args[0] === "show") return JSON.stringify(args[1].endsWith(":package.json") ? manifest : lock);
    // The release tag does not exist yet, so a verified merge creates it.
    if (args.includes("refs/tags/v0.0.16")) throw Object.assign(new Error("missing"), { status: 1 });
    return commit;
  };
  const never = () => assert.fail("an unverified merge must not reach the tag API");
  const green = { name: "Verify", status: "completed", conclusion: "success" };
  const policy = { name: "PR policy", status: "completed", conclusion: "success" };

  // Merged while Verify was still running: the merge button stays available
  // during a run because this plan cannot require the checks server side.
  assert.throws(() => tagMergedPr(pr, repository, git, never,
    () => [policy, { name: "Verify", status: "in_progress", conclusion: null }]),
  /Verify was still in_progress .*merged before its checks finished/);

  for (const conclusion of ["failure", "cancelled", "timed_out", "skipped", "action_required"]) {
    assert.throws(() => tagMergedPr(pr, repository, git, never,
      () => [policy, { name: "Verify", status: "completed", conclusion }]),
    new RegExp(`Verify concluded ${conclusion}`));
  }

  // A check that never ran at all, and one whose API could not be read, are
  // both refusals: nothing is published on a guess.
  assert.throws(() => tagMergedPr(pr, repository, git, never, () => [green]),
    /PR policy never ran/);
  assert.throws(() => tagMergedPr(pr, repository, git, never,
    () => { throw new Error("Could not read the checks for " + head + "."); }), /Could not read the checks/);

  // Without a head commit there is nothing whose checks could be read.
  assert.throws(() => tagMergedPr({ ...pr, head: undefined }, repository, git, never, checksPassed),
    /no head commit whose checks can be read/);

  // Both green on the merged commit is what lets the tag be created.
  const created = [];
  assert.deepEqual(
    tagMergedPr(pr, repository, git, (tag, target) => created.push({ tag, target }), () => [policy, green]),
    { kind: "release", tag: "v0.0.16", commit });
  assert.deepEqual(created, [{ tag: "v0.0.16", target: commit }]);
});

test("every kind of merge is held to its checks, not only a release", () => {
  const repository = "Okamishimo/csv-table-editor";
  const commit = "a".repeat(40);
  const git = () => commit;
  for (const title of ["Docs: explain the workflow", "Feature: add a thing", "Fix: correct a thing"]) {
    const pr = { merged: true, base: { ref: "main", repo: { full_name: repository } },
      head: { sha: "c".repeat(40) }, title, merge_commit_sha: commit };
    assert.throws(() => tagMergedPr(pr, repository, git,
      () => assert.fail("nothing may be tagged"),
      () => [{ name: "PR policy", status: "completed", conclusion: "success" },
        { name: "Verify", status: "completed", conclusion: "failure" }]),
    /Verify concluded failure/, title);
  }
});

test("PR types require an exact prefix and a nonempty single-line description", () => {
  assert.equal(prKind("Docs: clarify the release guide"), "docs");
  assert.equal(prKind("Feature: column-scoped search"), "feature");
  assert.equal(prKind("Fix: stop the preview flickering"), "fix");
  assert.equal(prKind("Release v0.0.16: code changes"), "release");
  for (const title of ["Docs:", "Docs: ", "docs: x", "Docs:x", "Docs: x\ncode", "Docs: x\r", "Documentation: x",
    "Release v0.0.016: x", "Feature:", "Feature: ", "feature: x", "Feature:x", "Feature: x\ny",
    "Fix:", "fix: x", "Fixes: x", "Fix: x\ny", "Prefix Fix: x"]) {
    assert.throws(() => prKind(title), /PR title must/);
  }
});

test("only a release PR moves the version, and it must move all three fields", () => {
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  // Versions this fake repository reports for each commit.
  const at = { [base]: { version: "0.0.15" }, [head]: { version: "0.0.15" } };
  const git = (args) => {
    if (args[0] === "rev-parse") throw Object.assign(new Error("missing tag"), { status: 1 });
    assert.equal(args[0], "show");
    const [sha, file] = args[1].split(":");
    const version = at[sha].version;
    return JSON.stringify(file === "package.json"
      ? { version } : { version, packages: { "": { version } } });
  };

  // Feature and Fix leave the version alone, and never look up a tag.
  assert.deepEqual(checkPr("Feature: add a thing", base, head, git), { kind: "feature" });
  assert.deepEqual(checkPr("Fix: correct a thing", base, head, git), { kind: "fix" });

  // A release PR that forgot the bump is refused before anything else.
  assert.throws(() => checkPr("Release v0.0.15: no bump", base, head, git),
    /must change the version in package.json and package-lock.json/);

  at[head] = { version: "0.0.16" };
  assert.deepEqual(checkPr("Release v0.0.16: bumped", base, head, git), { kind: "release", tag: "v0.0.16" });
  for (const title of ["Feature: sneak a bump in", "Fix: sneak a bump in"]) {
    assert.throws(() => checkPr(title, base, head, git), /Only a release PR may change the version/);
  }
});

test("a merged feature or fix PR makes no tag API call or version lookup", () => {
  const repository = "Okamishimo/csv-table-editor";
  const commit = "a".repeat(40);
  const git = (args) => {
    assert.ok(["rev-parse", "merge-base"].includes(args[0]), "an unpublished merge must not read versions or tags");
    return commit;
  };
  for (const [title, kind] of [["Feature: add a thing", "feature"], ["Fix: correct a thing", "fix"]]) {
    const pr = { merged: true, base: { ref: "main", repo: { full_name: repository } },
      head: { sha: "c".repeat(40) }, title, merge_commit_sha: commit };
    assert.deepEqual(tagMergedPr(pr, repository, git, () => assert.fail("only a release may create a tag"), checksPassed),
      { kind, tag: "", commit });
  }
});

test("merged documentation PRs make no tag API call or version lookup, including on retry", () => {
  const repository = "Okamishimo/csv-table-editor";
  const commit = "a".repeat(40);
  const pr = { merged: true, base: { ref: "main", repo: { full_name: repository } },
    head: { sha: "c".repeat(40) }, title: "Docs: explain the workflow", merge_commit_sha: commit };
  const git = (args) => {
    assert.ok(["rev-parse", "merge-base"].includes(args[0]), "Docs merges must not read versions or tags");
    return commit;
  };
  for (let retry = 0; retry < 2; retry++) {
    assert.deepEqual(tagMergedPr(pr, repository, git, () => assert.fail("Docs must never create a tag"), checksPassed),
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
    if (args[1] === `${base}:package-lock.json`) return JSON.stringify({ version: "0.0.15", packages: { "": { version: "0.0.15" } } });
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
    assert.match(step, /if: needs.policy.outputs.kind (?:==|!=) 'docs'/);
    // Only documentation skips the suite; Feature, Fix and Release all run it.
    if (/npm ci|npm run verify|actions\//.test(step)) assert.match(step, /if: needs.policy.outputs.kind != 'docs'/);
  }
});
