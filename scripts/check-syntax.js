"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
for (const directory of ["src", "scripts", "test", "dist"]) {
  for (const file of fs.readdirSync(path.join(root, directory))) {
    if (file.endsWith(".js")) execFileSync(process.execPath, ["--check", path.join(root, directory, file)], { stdio: "inherit" });
  }
}
console.log("JavaScript syntax checks passed.");
