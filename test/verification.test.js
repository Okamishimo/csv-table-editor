"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");
const { verify } = require("../scripts/verify");

function fixture(t, warningStep, warningType = "Warning") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csv verify "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "scripts", "verify-patch-idempotency.js"), 'require("node:fs").appendFileSync("steps", "idempotency\\n");');
  const npm = path.join(root, "fake-npm.js");
  fs.writeFileSync(npm, `
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const step = process.argv[2] === 'run' ? process.argv[3] : process.argv[2];
    fs.appendFileSync('steps', step + '\\n');
    if (step === ${JSON.stringify(warningStep)}) {
      const child = spawnSync(process.execPath, ['-e', ${JSON.stringify(`process.emitWarning("example tool warning", ${JSON.stringify(warningType)});`)}], { stdio: 'inherit' });
      process.exitCode = child.status === 0 ? 0 : 1;
    } else {
      console.error('Example expected error output, not a process warning.');
    }
  `);
  return { root, npm, steps: () => fs.readFileSync(path.join(root, "steps"), "utf8").trim().split("\n") };
}

const quietRun = (command, args, options) => execFileSync(command, args, { ...options, stdio: "pipe" });

test("verification runs build, tests and idempotency in order and permits ordinary diagnostic test output", (t) => {
  const { root, npm, steps } = fixture(t);
  verify(root, npm, quietRun);
  assert.deepEqual(steps(), ["build", "test", "idempotency"]);
});

for (const warningStep of ["build", "test"]) {
  for (const warningType of ["Warning", "DeprecationWarning", "ExperimentalWarning"]) {
    test(`${warningType} from a ${warningStep} subprocess fails verification before the next step`, (t) => {
      const { root, npm, steps } = fixture(t, warningStep, warningType);
      assert.throws(() => verify(root, npm, quietRun), (error) => {
        assert.equal(error.status, 1);
        assert.match(error.stderr.toString(), /example tool warning/);
        return true;
      });
      assert.deepEqual(steps(), warningStep === "build" ? ["build"] : ["build", "test"]);
    });
  }
}

test("the warning preload also fails Node syntax checks and test workers", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csv warning preload "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const preload = path.join(root, "example preload.js");
  const source = path.join(root, "example.js");
  fs.writeFileSync(preload, `require(${JSON.stringify(path.resolve(__dirname, "../scripts/fail-on-warnings.js"))}); process.emitWarning("example syntax warning");`);
  fs.writeFileSync(source, "const value = 1;\n");
  const env = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
  const syntax = spawnSync(process.execPath, ["--check", source], { env, encoding: "utf8" });
  assert.equal(syntax.status, 1);
  assert.match(syntax.stderr, /example syntax warning/);

  fs.writeFileSync(source, 'require("node:test")("example test", () => { process.emitWarning("example test warning"); });\n');
  const workerEnv = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(path.resolve(__dirname, "../scripts/fail-on-warnings.js"))}` };
  // This is a separate test run, outside the current runner's worker protocol.
  delete workerEnv.NODE_TEST_CONTEXT;
  const workers = spawnSync(process.execPath, ["--test", source], {
    env: workerEnv,
    encoding: "utf8"
  });
  assert.equal(workers.status, 1);
  assert.match(workers.stdout + workers.stderr, /example test warning/);
});

test("verification requires npm and preserves existing Node options", (t) => {
  assert.throws(() => verify("unused", ""), /npm run verify/);
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--stack-trace-limit=20";
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  });
  verify("unused", "example-npm.js", (_command, _args, options) => {
    assert.match(options.env.NODE_OPTIONS, /^--stack-trace-limit=20 --require /);
  });
});
