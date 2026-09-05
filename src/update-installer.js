"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { UpdateError } = require("./update-artifact");

function cliInvocation(vscode, context, filePath, product, platform = process.platform, environment = process.env) {
  if (!["darwin", "win32"].includes(platform) || vscode.env.remoteName && context.extension.extensionKind !== vscode.ExtensionKind.UI) {
    throw new UpdateError("Private CLI updates support local macOS and Windows extension installations only.");
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

async function installVsix(vscode, context, filePath, run = promisify(execFile)) {
  try {
    const product = JSON.parse(await fs.readFile(path.join(vscode.env.appRoot, "product.json"), "utf8"));
    const invocation = cliInvocation(vscode, context, filePath, product);
    await fs.access(invocation.executable);
    await fs.access(invocation.args[0]);
    await run(invocation.executable, invocation.args, invocation.options);
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw new UpdateError("VS Code CLI installation failed or timed out. Check disk space, VS Code compatibility, and extension installation permissions.");
  }
}

module.exports = { cliInvocation, installVsix };
