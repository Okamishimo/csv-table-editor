"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function install() {
  const root = path.resolve(__dirname, "..");
  if (process.env.CI || !fs.existsSync(path.join(root, ".git"))) return;
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  let configured;
  try { configured = git(["config", "--get", "core.hooksPath"]); }
  catch (error) { if (error.status !== 1) throw error; }
  if (configured && configured !== ".githooks") throw new Error("Existing core.hooksPath was preserved. Integrate the repository hooks before committing.");
  if (!configured) {
    const hooks = git(["rev-parse", "--git-path", "hooks"]);
    for (const name of ["pre-commit", "pre-push"]) {
      if (fs.existsSync(path.resolve(root, hooks, name))) throw new Error(`Existing ${name} hook was preserved. Integrate it before installing repository hooks.`);
    }
  }
  for (const name of ["pre-commit", "pre-push"]) fs.chmodSync(path.join(root, ".githooks", name), 0o755);
  git(["config", "--local", "core.hooksPath", ".githooks"]);
  console.log("Installed pre-commit verification and main/tag pre-push guards.");
}

if (require.main === module) {
  try { install(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { install };
