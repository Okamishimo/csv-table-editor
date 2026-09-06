"use strict";

const ROOT_DOCS = new Set(["readme.md", "changelog.md", "AGENTS.md", "CLAUDE.md"]);

function isDocumentation(file) {
  if (file.split("/").some((part) => !part || part === "." || part === "..")) return false;
  return ROOT_DOCS.has(file) || file === ".github/release-rules.md" ||
    /^docs\/.+\.md$/.test(file) ||
    /^\.(?:agents|claude)\/skills\/[a-z0-9-]+\/(?:SKILL\.md|references\/.+\.md)$/.test(file);
}

function checkDocumentation(base, head, runGit) {
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha || ""))) throw new Error("Missing PR base or head commit.");
  const range = `${base}...${head}`;
  // No rename detection: moving code into docs must still expose the deleted
  // code path. NUL delimiters preserve spaces, tabs and newlines in filenames.
  const fields = runGit(["diff", "--raw", "-z", "--no-abbrev", "--no-renames", range, "--"]).split("\0");
  if (fields.pop() !== "" || fields.length === 0 || fields.length % 2) throw new Error("Expected a nonempty documentation diff.");
  const rejected = [];
  for (let i = 0; i < fields.length; i += 2) {
    const metadata = /^:(\d{6}) (\d{6}) [a-f0-9]{40} [a-f0-9]{40} [AMDT]$/.exec(fields[i]);
    if (!metadata) throw new Error("Unexpected Git diff metadata; documentation check failed.");
    const file = fields[i + 1];
    if (!isDocumentation(file) || metadata.slice(1).some((mode) => mode !== "100644" && mode !== "000000")) rejected.push(file);
  }
  if (rejected.length) {
    throw new Error(`Docs PR contains non-documentation paths or non-regular files: ${rejected.map((file) => JSON.stringify(file)).join(", ")}. Use a Release PR for code/configuration changes.`);
  }
  try { runGit(["diff", "--check", range, "--"]); }
  catch { throw new Error("Documentation whitespace check failed. Run git diff --check against the PR base and fix the reported lines."); }
  return fields.length / 2;
}

module.exports = { isDocumentation, checkDocumentation };
