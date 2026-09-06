"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function verifyStaged(root, npmCli = process.env.npm_execpath) {
  if (!npmCli) throw new Error("Run this hook through npm run precommit.");
  if (!fs.existsSync(path.join(root, "node_modules"))) throw new Error("Run npm ci before committing.");
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), "csv-staged-"));
  try {
    const index = () => execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: root });
    const staged = index();
    // Export the index, so unstaged fixes cannot hide a broken staged commit.
    execFileSync("git", ["checkout-index", "--all", `--prefix=${snapshot.replaceAll("\\", "/")}/`], { cwd: root });
    const bundle = path.join(snapshot, "dist", "extension.js");
    const before = fs.readFileSync(bundle);
    fs.symlinkSync(path.join(root, "node_modules"), path.join(snapshot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const env = { ...process.env };
    // Tests may create their own temporary Git repositories.
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    execFileSync(process.execPath, [npmCli, "run", "verify"], { cwd: snapshot, env, stdio: "inherit" });
    if (!fs.readFileSync(bundle).equals(before)) throw new Error("Build changed the staged distribution. Run npm run build, stage dist/extension.js, and commit again.");
    if (!index().equals(staged)) throw new Error("The Git index changed during verification. Commit again to test the new staged contents.");
  } finally {
    fs.rmSync(snapshot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { verifyStaged(path.resolve(__dirname, "..")); }
  catch (error) {
    console.error(error.status !== undefined ? "Staged verification failed; commit blocked." : error.message);
    process.exitCode = 1;
  }
}

module.exports = { verifyStaged };
