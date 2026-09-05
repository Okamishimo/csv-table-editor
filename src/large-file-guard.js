"use strict";

const MIB = 1024 * 1024;
const DEFAULT_MAX_FILE_SIZE_MB = 64;
const HARD_MAX_FILE_SIZE_MB = 511;
const OPEN_AS_TEXT = "Open as Text";

async function ensureFileCanOpen(uri, vscode) {
  if (!uri || uri.scheme === "untitled") return;

  const stat = await vscode.workspace.fs.stat(uri);
  const configuredLimit = Number(
    vscode.workspace.getConfiguration("csvTableEditor").get("maxFileSizeMB", DEFAULT_MAX_FILE_SIZE_MB)
  );
  const maximumMegabytes = clampLimit(configuredLimit);
  const maximumBytes = maximumMegabytes * MIB;
  if (stat.size <= maximumBytes) return;

  const message =
    `CSV Table Editor cannot safely load ${formatBytes(stat.size)} into its in-memory grid. ` +
    `The current limit is ${maximumMegabytes} MiB. Open it as text instead, or change ` +
    `csvTableEditor.maxFileSizeMB for files below the 511 MiB hard limit.`;
  const action = await vscode.window.showWarningMessage(message, OPEN_AS_TEXT);
  if (action === OPEN_AS_TEXT) {
    await vscode.commands.executeCommand("vscode.openWith", uri, "default");
  }

  const error = new RangeError(message);
  error.code = "CSV_TABLE_EDITOR_FILE_TOO_LARGE";
  error.fileSize = stat.size;
  error.limit = maximumBytes;
  throw error;
}

function clampLimit(value) {
  if (!Number.isFinite(value)) return DEFAULT_MAX_FILE_SIZE_MB;
  return Math.min(HARD_MAX_FILE_SIZE_MB, Math.max(1, Math.floor(value)));
}

function formatBytes(bytes) {
  if (bytes < MIB) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

module.exports = {
  DEFAULT_MAX_FILE_SIZE_MB,
  HARD_MAX_FILE_SIZE_MB,
  ensureFileCanOpen,
  clampLimit,
  formatBytes,
};
