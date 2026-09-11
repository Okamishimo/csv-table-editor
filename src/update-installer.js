"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { UpdateError } = require("./update-artifact");

function cliInvocation(vscode, context, filePath, product, platform = process.platform, environment = process.env) {
  if (!["darwin", "win32"].includes(platform) || vscode.env.remoteName && context.extension.extensionKind !== vscode.ExtensionKind.UI) {
    throw new UpdateError("CLI updates support local macOS and Windows extension installations only.");
  }
  const paths = platform === "win32" ? path.win32 : path.posix;
  const appRoot = vscode.env.appRoot;
  if (!product.nameShort || /[\\/]/.test(product.nameShort)) throw new UpdateError("Cannot locate this VS Code installation's CLI.");
  const executable = platform === "darwin" ? paths.resolve(appRoot, "../../MacOS", product.nameShort) :
    paths.resolve(appRoot, "../..", `${product.nameShort}.exe`);
  // globalStorageUri identifies the actual user-data directory, including portable
  // and custom --user-data-dir installations. A named profile needs its CLI name.
  const globalStorage = paths.dirname(context.globalStorageUri.fsPath);
  const userOrProfile = paths.dirname(globalStorage);
  const namedProfile = paths.basename(paths.dirname(userOrProfile)) === "profiles";
  const userDirectory = namedProfile ? paths.dirname(paths.dirname(userOrProfile)) : userOrProfile;
  if (paths.basename(globalStorage) !== "globalStorage" || paths.basename(userDirectory) !== "User") {
    throw new UpdateError("Cannot determine the current VS Code user-data directory.");
  }
  const profileName = vscode.workspace.getConfiguration("csvTableEditor.updates").get("profileName", "").trim();
  if (namedProfile && !profileName) throw new UpdateError("Set csvTableEditor.updates.profileName to this VS Code profile's exact name before updating.");
  const args = [paths.join(appRoot, "out", "cli.js"), "--install-extension", filePath, "--force",
    "--user-data-dir", paths.dirname(userDirectory), "--extensions-dir", paths.dirname(context.extensionUri.fsPath)];
  if (profileName) args.push("--profile", profileName);
  const env = { ...environment, ELECTRON_RUN_AS_NODE: "1" };
  for (const key of ["NODE_OPTIONS", "NODE_REPL_EXTERNAL_MODULE", "VSCODE_NODE_OPTIONS", "VSCODE_NODE_REPL_EXTERNAL_MODULE",
    "VSCODE_DEV", "VSCODE_IPC_HOOK_CLI", "VSCODE_CLI"]) delete env[key];
  return { executable, args, options: { env, shell: false, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 } };
}

function installationError(error) {
  const clean = (value) => String(value ?? "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/https?:\/\/[^\s<>"']+/gi, "[redacted URL]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[redacted authorization]")
    .replace(/\b(?:gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+)/gi, "[redacted token]")
    .replace(/\b((?:access[_-]?token|token|password|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .trim();
  // execFile's message repeats the command and stderr. Prefer the actual CLI
  // output; some VS Code versions report installation errors on stdout instead.
  const detail = [clean(error?.stderr), clean(error?.stdout)].filter(Boolean).join("\n") || clean(error?.message);
  const status = [
    error?.code != null && `code ${clean(error.code)}`,
    error?.signal && `signal ${clean(error.signal)}`,
    error?.killed && "process terminated (timeout or cancellation)",
  ].filter(Boolean).join(", ");
  const message = `VS Code CLI installation failed${status ? ` (${status})` : ""}.${detail ? `\n${detail}` : ""}`;
  return new UpdateError(message.length > 4000 ? `${message.slice(0, 4000)}\n[truncated]` : message);
}

async function installVsix(vscode, context, filePath, run = promisify(execFile), platform = process.platform) {
  try {
    const product = JSON.parse(await fs.readFile(path.join(vscode.env.appRoot, "product.json"), "utf8"));
    const invocation = cliInvocation(vscode, context, filePath, product, platform);
    await fs.access(invocation.executable);
    await fs.access(invocation.args[0]);
    await run(invocation.executable, invocation.args, invocation.options);
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw installationError(error);
  }
}

module.exports = { cliInvocation, installVsix };
