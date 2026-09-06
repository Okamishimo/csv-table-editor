"use strict";

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { assertOnMain } = require("./release-policy");

function checkPush(input, remote, runGit = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()) {
  const updates = input.trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(/\s+/));
  if (updates.some(([, , ref]) => ref === "refs/heads/main")) throw new Error("Direct pushes to main are blocked. Open a Docs or Release PR instead.");
  const tags = updates.filter(([, , ref]) => ref.startsWith("refs/tags/"));
  if (!tags.length) return;
  if (remote !== "origin") throw new Error("Push tags through origin so their commits can be checked against main.");
  // Refresh main from the server; a stale local main must not authorize a tag.
  runGit(["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  for (const [, sha, , previous] of tags) {
    if (/^0+$/.test(sha) || !/^0+$/.test(previous)) throw new Error("Existing tags must never be deleted or replaced.");
    assertOnMain(sha, runGit);
  }
}

if (require.main === module) {
  try { checkPush(fs.readFileSync(0, "utf8"), process.argv[2]); }
  catch (error) {
    console.error(error.status !== undefined ? "Cannot verify remote main; tag push blocked." : error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkPush };
