"use strict";

const path = require("node:path");
const { execFileSync } = require("node:child_process");

function verify(root, npmCli = process.env.npm_execpath, runNode = execFileSync) {
  if (!npmCli) throw new Error("Run verification through npm run verify.");
  const preload = path.join(__dirname, "fail-on-warnings.js");
  // NODE_OPTIONS also reaches syntax checks and test workers spawned by npm.
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require ${JSON.stringify(preload)}`.trim() };
  for (const args of [
    [npmCli, "run", "build"],
    [npmCli, "test"],
    [path.join(root, "scripts", "verify-patch-idempotency.js")]
  ]) {
    runNode(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  }
}

if (require.main === module) {
  try { verify(path.join(__dirname, "..")); }
  catch (error) {
    console.error(error.status !== undefined ? "Verification failed; warnings are errors." : error.message);
    process.exitCode = 1;
  }
}

module.exports = { verify };
