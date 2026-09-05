"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ensureFileCanOpen,
  clampLimit,
  formatBytes,
} = require("../src/large-file-guard");

function vscodeStub(size, configuredLimit, selectedAction) {
  const calls = { warnings: [], commands: [] };
  return {
    calls,
    workspace: {
      fs: { stat: async () => ({ size }) },
      getConfiguration: () => ({ get: () => configuredLimit }),
    },
    window: {
      showWarningMessage: async (...args) => {
        calls.warnings.push(args);
        return selectedAction;
      },
    },
    commands: {
      executeCommand: async (...args) => calls.commands.push(args),
    },
  };
}

test("allows files at or below the configured size", async () => {
  const vscode = vscodeStub(64 * 1024 * 1024, 64);
  await ensureFileCanOpen({ scheme: "file" }, vscode);
  assert.equal(vscode.calls.warnings.length, 0);
});

test("offers to reopen oversized files as text and stops grid loading", async () => {
  const vscode = vscodeStub(600 * 1024 * 1024, 64, "Open as Text");
  const uri = { scheme: "file", path: "/large.csv" };

  await assert.rejects(
    ensureFileCanOpen(uri, vscode),
    (error) => error.code === "CSV_TABLE_EDITOR_FILE_TOO_LARGE" && error.fileSize === 600 * 1024 * 1024
  );
  assert.equal(vscode.calls.warnings.length, 1);
  assert.deepEqual(vscode.calls.commands, [["vscode.openWith", uri, "default"]]);
});

test("caps configuration below the JavaScript string limit", () => {
  assert.equal(clampLimit(Number.NaN), 64);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(800), 511);
  assert.equal(formatBytes(600 * 1024 * 1024), "600.0 MiB");
});
