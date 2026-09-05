"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const bundle = path.join(__dirname, "..", "dist", "extension.js");
const before = fs.readFileSync(bundle);
execFileSync(process.execPath, [path.join(__dirname, "patch-distribution.js")], { stdio: "inherit" });
assert.deepEqual(fs.readFileSync(bundle), before, "Applying the distribution patch twice must not change the bundle");
console.log("Distribution patch is idempotent.");
