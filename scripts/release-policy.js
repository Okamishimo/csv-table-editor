"use strict";

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { stableVersion, isNewer } = require("../src/update-artifact");
const { REPOSITORY } = require("../src/github-release-client");
const { checkDocumentation } = require("./docs-policy");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function prKind(title) {
  if (/^Docs: \S[^\r\n]*$/.test(title || "")) return "docs";
  if (/^Release v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*): \S[^\r\n]*$/.test(title || "")) return "release";
  throw new Error("PR title must be Docs: description or Release vX.Y.Z: description.");
}

function checkPr(title, baseSha, headSha, runGit = git) {
  if (![baseSha, headSha].every((sha) => /^[a-f0-9]{40}$/.test(sha || ""))) throw new Error("Missing PR base or head commit.");
  const kind = prKind(title);
  if (kind === "docs") return { kind, files: checkDocumentation(baseSha, headSha, runGit) };
  const manifest = JSON.parse(runGit(["show", `${headSha}:package.json`]));
  const lock = JSON.parse(runGit(["show", `${headSha}:package-lock.json`]));
  const base = JSON.parse(runGit(["show", `${baseSha}:package.json`]));
  const tag = validateTitle(title, manifest, lock, base);
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
}) {
  if (repository !== REPOSITORY || !pr?.merged || pr.base?.ref !== "main" ||
      pr.base.repo?.full_name !== REPOSITORY || !/^[a-f0-9]{40}$/.test(pr.merge_commit_sha || "")) {
    throw new Error("Only a merged PR into this repository's main can create a release tag.");
  }
  const commit = assertOnMain(pr.merge_commit_sha, runGit);
  if (prKind(pr.title) === "docs") return { kind: "docs", tag: "", commit };
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
    console.log(result.kind === "docs" ? `Documentation scope and whitespace checks passed for ${result.files} files.` : `Release PR policy passed for ${result.tag}.`);
  } else if (command === "check-tag") {
    const tag = process.env.RELEASE_TAG;
    if (!tag?.startsWith("v") || !stableVersion(tag.slice(1))) throw new Error("Expected a stable vX.Y.Z tag.");
    assertOnMain(`refs/tags/${tag}`);
  } else if (command === "tag") {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const { kind, tag, commit } = tagMergedPr(event.pull_request, process.env.GITHUB_REPOSITORY);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `kind=${kind}\ntag=${tag}\n`);
    console.log(kind === "docs" ? "Documentation PR merged; no tag or release will be created." : `${tag} points to merged main commit ${commit}.`);
  } else throw new Error("Expected pr, check-tag, or tag.");
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(error.status !== undefined ? "Git/GitHub policy operation failed; no existing tag was moved." : error.message);
    process.exitCode = 1;
  }
}

module.exports = { prKind, checkPr, validateTitle, assertOnMain, ensureTagTarget, tagMergedPr, main };
