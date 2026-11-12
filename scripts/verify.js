"use strict";

const path = require("node:path");
const { execFileSync } = require("node:child_process");

function verify(root, npmCli = process.env.npm_execpath, runNode = execFileSync, step = "all") {
  if (!npmCli) throw new Error("Run verification through npm run verify.");
  const steps = {
    build: [npmCli, "run", "build"],
    test: [npmCli, "test"],
    idempotency: [path.join(root, "scripts", "verify-patch-idempotency.js")]
  };
  if (step !== "all" && !Object.hasOwn(steps, step)) {
    throw new Error("Unknown verification step. Choose build, test, or idempotency.");
  }
  const preload = path.join(__dirname, "fail-on-warnings.js");
  // NODE_OPTIONS also reaches syntax checks and test workers spawned by npm.
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require ${JSON.stringify(preload)}`.trim() };
  for (const [name, args] of Object.entries(steps)) {
    if (step !== "all" && step !== name) continue;
    runNode(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  }
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== "--step")) {
      throw new Error("Usage: npm run verify [-- --step build|test|idempotency]");
    }
    verify(path.join(__dirname, ".."), undefined, undefined, args.length ? args[1] : "all");
  }
  catch (error) {
    console.error(error.status !== undefined ? "Verification failed; warnings are errors." : error.message);
    process.exitCode = 1;
  }
}

module.exports = { verify };
