"use strict";

const fs = require("node:fs");
const path = require("node:path");

function patchDependencies(root = path.join(__dirname, "..")) {
  const manifest = require.resolve("jsdom/package.json", { paths: [root] });
  const file = path.join(path.dirname(manifest), "lib/jsdom/living/css/serialize.js");
  const source = fs.readFileSync(file, "utf8");
  const original = 'function serializeNumberFromPrimitive(value) {\n  return `${Number(value.toPrecision(6))}`;\n}';
  // CSSOM limits decimal places, not significant digits; large spacers must stay exact.
  const patched = original.replace("toPrecision(6)", "toFixed(6)");
  if (source.split(patched).length === 2 && !source.includes(original)) return;
  if (source.split(original).length !== 2 || source.includes(patched)) {
    throw new Error("Cannot apply the jsdom CSS precision compatibility fix: review the changed upstream serializer.");
  }
  fs.writeFileSync(file, source.replace(original, patched));
  console.log("Applied jsdom CSS number precision compatibility fix.");
}

if (require.main === module) {
  try { patchDependencies(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { patchDependencies };
