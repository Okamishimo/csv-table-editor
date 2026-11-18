"use strict";

const { UpdateError } = require("./update-artifact");

function installationError(error) {
  const clean = (value) => String(value ?? "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/https?:\/\/[^\s<>"']+/gi, "[redacted URL]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[redacted authorization]")
    .replace(/\b(?:gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+)/gi, "[redacted token]")
    .replace(/\b((?:access[_-]?token|token|password|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .trim();
  const detail = clean(error?.message ?? error);
  const status = error?.code != null ? ` (code ${clean(error.code)})` : "";
  const message = `VS Code extension installation failed${status}.${detail ? `\n${detail}` : ""}`;
  return new UpdateError(message.length > 4000 ? `${message.slice(0, 4000)}\n[truncated]` : message);
}

async function installVsix(vscode, context, filePath, platform = process.platform) {
  if (!["darwin", "win32"].includes(platform) ||
      vscode.env.remoteName && context.extension.extensionKind !== vscode.ExtensionKind.UI ||
      context.extensionMode !== vscode.ExtensionMode.Production) {
    throw new UpdateError("Automatic updates support installed, local macOS and Windows extensions only.");
  }
  try {
    // Pass a URI: a string is treated as a Marketplace extension ID. VS Code
    // owns the installation and current profile; wait before deleting the VSIX.
    await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(filePath));
  } catch (error) {
    throw installationError(error);
  }
}

module.exports = { installVsix };
