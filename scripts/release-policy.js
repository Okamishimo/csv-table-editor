"use strict";

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { stableVersion, isNewer } = require("../src/update-artifact");
const { REPOSITORY } = require("../src/github-release-client");
const { checkDocumentation } = require("./docs-policy");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * The checks a merge must have passed, on the very commit that was merged.
 *
 * This repository's plan cannot require them server side, so the merge button
 * stays available while `Verify` is still running and after it has failed.
 * Merging is therefore not evidence that anything was verified, and a merge
 * that jumped the checks must not become a tag, a package, or a release.
 */
const REQUIRED_CHECKS = ["PR policy", "Verify"];

/** The latest run of each check on a commit. */
function listCheckRuns(sha) {
  let response;
  try {
    response = execFileSync("gh", ["api", "--method", "GET",
      `repos/${REPOSITORY}/commits/${sha}/check-runs`, "-f", "filter=latest", "-f", "per_page=100"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error(`Could not read the checks for ${sha}. Nothing is tagged or published on a guess.`);
  }
  return JSON.parse(response).check_runs || [];
}

/**
 * Refuse a merge whose required checks had not passed on its own head commit.
 * A check that is still running is not a pass, and neither is an API that
 * cannot be reached.
 */
function assertChecksPassed(sha, runs = listCheckRuns) {
  if (!/^[a-f0-9]{40}$/.test(sha || "")) throw new Error("The merged PR has no head commit whose checks can be read.");
  const found = runs(sha);
  for (const name of REQUIRED_CHECKS) {
    const run = found.find((check) => check.name === name);
    if (!run) throw new Error(`${name} never ran on merged commit ${sha}; this merge is not verified.`);
    if (run.status !== "completed") {
      throw new Error(`${name} was still ${run.status} on merged commit ${sha}; this PR was merged before its checks finished.`);
    }
    if (run.conclusion !== "success") {
      throw new Error(`${name} concluded ${run.conclusion} on merged commit ${sha}; this merge is not verified.`);
    }
  }
}

/**
 * The four kinds of pull request, told apart by their title alone.
 *
 * `docs` carries documentation and is checked against the documentation
 * allowlist. `feature` and `fix` carry ordinary work: fully verified, merged
 * whenever they are ready, and never tagged or published. `release` is what
 * publishes, and it is the only kind allowed to change the version.
 */
function prKind(title) {
  if (/^Docs: \S[^\r\n]*$/.test(title || "")) return "docs";
  if (/^Feature: \S[^\r\n]*$/.test(title || "")) return "feature";
  if (/^Fix: \S[^\r\n]*$/.test(title || "")) return "fix";
  if (/^Release v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*): \S[^\r\n]*$/.test(title || "")) return "release";
  throw new Error("PR title must be Docs:, Feature: or Fix: description, or Release vX.Y.Z: description.");
}

/** The three version fields a release moves, as one commit records them. */
function versionsAt(sha, runGit) {
  const manifest = JSON.parse(runGit(["show", `${sha}:package.json`]));
  const lock = JSON.parse(runGit(["show", `${sha}:package-lock.json`]));
  return { manifest, lock, fields: [manifest.version, lock.version, lock.packages?.[""]?.version] };
}

function checkPr(title, baseSha, headSha, runGit = git) {
  if (![baseSha, headSha].every((sha) => /^[a-f0-9]{40}$/.test(sha || ""))) throw new Error("Missing PR base or head commit.");
  const kind = prKind(title);
  if (kind === "docs") return { kind, files: checkDocumentation(baseSha, headSha, runGit) };

  const base = versionsAt(baseSha, runGit);
  const head = versionsAt(headSha, runGit);
  const moved = head.fields.some((field, index) => field !== base.fields[index]);

  // Feature and Fix work accumulates on main at one version; the release that
  // publishes it is what moves that version. A bump merged without a release
  // would leave main claiming a version no tag and no VSIX ever carried.
  if (kind !== "release") {
    if (moved) throw new Error("Only a release PR may change the version. Leave package.json and package-lock.json as they are.");
    return { kind };
  }

  // A release PR must carry the bump itself, in the manifest and the lockfile.
  if (!moved) throw new Error("A release PR must change the version in package.json and package-lock.json.");
  const tag = validateTitle(title, head.manifest, head.lock, base.manifest);
  if (existingTag(tag, runGit)) throw new Error("This release version already has a tag. Increment the version.");
  return { kind, tag };
}

function validateTitle(title, manifest, lock, base) {
  const match = /^Release v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)): \S[^\r\n]*$/.exec(title || "");
  if (!match || !stableVersion(match[1])) throw new Error("PR title must start with Release vX.Y.Z: followed by a description.");
  const version = match[1];
  if (manifest.version !== version || lock.version !== version || lock.packages?.[""]?.version !== version) {
    throw new Error("PR title, package.json and both package-lock.json versions must match.");
  }
  if (base && !isNewer(version, base.version)) throw new Error("Every release PR must increment the version from main.");
  return `v${version}`;
}

function assertOnMain(ref, runGit = git) {
  // Peel annotated tags too; a tag must resolve to a commit, never a tree/blob.
  const commit = runGit(["rev-parse", "--verify", `${ref}^{commit}`]);
  try {
    runGit(["merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"]);
  } catch {
    throw new Error("Tags may only point to commits already on origin/main.");
  }
  return commit;
}

function existingTag(tag, runGit = git) {
  try {
    return runGit(["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`]);
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
}

function ensureTagTarget(tag, commit, runGit = git) {
  if (!existingTag(tag, runGit)) return false;
  if (runGit(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]) !== commit) {
    throw new Error("The release tag already points elsewhere. Increment the version; never move a tag.");
  }
  return true;
}

function tagMergedPr(pr, repository, runGit = git, createRef = (tag, commit) => {
  execFileSync("gh", ["api", "--method", "POST", `repos/${REPOSITORY}/git/refs`,
    "-f", `ref=refs/tags/${tag}`, "-f", `sha=${commit}`], { stdio: ["ignore", "pipe", "pipe"] });
}, runs = listCheckRuns) {
  if (repository !== REPOSITORY || !pr?.merged || pr.base?.ref !== "main" ||
      pr.base.repo?.full_name !== REPOSITORY || !/^[a-f0-9]{40}$/.test(pr.merge_commit_sha || "")) {
    throw new Error("Only a merged PR into this repository's main can create a release tag.");
  }
  const commit = assertOnMain(pr.merge_commit_sha, runGit);
  // Every kind is checked, not only a release: a merge that jumped the checks
  // is worth saying out loud even when it publishes nothing.
  assertChecksPassed(pr.head?.sha, runs);
  // Only a release publishes. Everything else merges and stops there, without
  // reading a version or reaching the tag API at all.
  const kind = prKind(pr.title);
  if (kind !== "release") return { kind, tag: "", commit };
  const manifest = JSON.parse(runGit(["show", `${commit}:package.json`]));
  const lock = JSON.parse(runGit(["show", `${commit}:package-lock.json`]));
  const tag = validateTitle(pr.title, manifest, lock);
  if (!ensureTagTarget(tag, commit, runGit)) createRef(tag, commit);
  return { kind: "release", tag, commit };
}

function main(command = process.argv[2]) {
  if (command === "pr") {
    const result = checkPr(process.env.PR_TITLE, process.env.PR_BASE_SHA, process.env.PR_HEAD_SHA);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `kind=${result.kind}\n`);
    console.log(
      result.kind === "docs" ? `Documentation scope and whitespace checks passed for ${result.files} files.`
        : result.kind === "release" ? `Release PR policy passed for ${result.tag}.`
          : `${result.kind === "feature" ? "Feature" : "Fix"} PR policy passed; this PR is verified in full and creates no tag.`
    );
  } else if (command === "check-tag") {
    const tag = process.env.RELEASE_TAG;
    if (!tag?.startsWith("v") || !stableVersion(tag.slice(1))) throw new Error("Expected a stable vX.Y.Z tag.");
    assertOnMain(`refs/tags/${tag}`);
  } else if (command === "tag") {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const { kind, tag, commit } = tagMergedPr(event.pull_request, process.env.GITHUB_REPOSITORY);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `kind=${kind}\ntag=${tag}\n`);
    console.log(kind === "release" ? `${tag} points to merged main commit ${commit}.`
      : `${kind} PR merged; no tag or release will be created.`);
  } else throw new Error("Expected pr, check-tag, or tag.");
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(error.status !== undefined ? "Git/GitHub policy operation failed; no existing tag was moved." : error.message);
    process.exitCode = 1;
  }
}

module.exports = { prKind, versionsAt, checkPr, validateTitle, assertOnMain, ensureTagTarget,
  REQUIRED_CHECKS, assertChecksPassed, tagMergedPr, main };
