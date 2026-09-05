"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createClient } = require("./github-release-client");
const { installVsix } = require("./update-installer");
const { UpdateError, isNewer, selectRelease, parseChecksum, verifyVsixManifest } = require("./update-artifact");

const TOKEN_KEY = "privateUpdates.githubToken";
const AUTH_KEY = "privateUpdates.authMethod";
const HOUR = 3600000;

async function acquireLock(directory) {
  const lockPath = path.join(directory, "lock");
  async function create() {
    await fs.mkdir(lockPath, { mode: 0o700 });
    const owner = path.join(lockPath, `owner-${process.pid}`);
    try { await fs.writeFile(owner, "", { flag: "wx", mode: 0o600 }); }
    catch (error) { await fs.rmdir(lockPath).catch(() => {}); throw error; }
    return async () => {
      await fs.unlink(owner);
      await fs.rmdir(lockPath);
    };
  }
  try { return await create(); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  // Recover an interrupted host without expiring a lock held by a live installer.
  try {
    const owners = await fs.readdir(lockPath);
    if (owners.length === 1 && /^owner-[1-9]\d*$/.test(owners[0])) {
      const pid = Number(owners[0].slice(6));
      try { process.kill(pid, 0); return null; }
      catch (error) { if (error.code !== "ESRCH") return null; }
      // Only the process that removes this dead owner's file may remove its directory.
      await fs.unlink(path.join(lockPath, owners[0]));
      await fs.rmdir(lockPath);
    } else if (owners.length === 0 && Date.now() - (await fs.stat(lockPath)).mtimeMs > 60000) {
      await fs.rmdir(lockPath);
    } else return null;
    return await create();
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)) return null;
    throw error;
  }
}

async function readState(directory) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(directory, "state.json"), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function writeState(directory, state) {
  const temporary = path.join(directory, `state-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, path.join(directory, "state.json"));
  } finally { await fs.rm(temporary, { force: true }); }
}

function createUpdater(context, vscode, dependencies = {}) {
  const client = dependencies.client || createClient();
  const install = dependencies.install || ((file) => installVsix(vscode, context, file));
  const verify = dependencies.verify || verifyVsixManifest;
  const now = dependencies.now || Date.now;
  const platform = dependencies.platform || process.platform;
  const output = vscode.window.createOutputChannel("CSV Table Editor Updates");
  const directory = path.join(context.globalStorageUri.fsPath, "private-updates");
  const manifest = context.extension.packageJSON;
  let disposed = false;
  let running;
  let startup;
  let interval;
  let reloadNotifiedVersion;
  const log = (message) => { if (!disposed) output.appendLine(`${new Date(now()).toISOString()} ${message}`); };
  const configuration = () => vscode.workspace.getConfiguration("csvTableEditor.updates");
  const supported = () => ["darwin", "win32"].includes(platform) &&
    !(vscode.env.remoteName && context.extension.extensionKind !== vscode.ExtensionKind.UI) &&
    context.extensionMode === vscode.ExtensionMode.Production;

  async function token() {
    const method = context.globalState.get(AUTH_KEY);
    if (method === "github") {
      return (await vscode.authentication.getSession("github", ["repo"], { silent: true }))?.accessToken;
    }
    if (method === "token") return context.secrets.get(TOKEN_KEY);
    return undefined;
  }

  async function checkLocked(manual) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const unlock = await acquireLock(directory);
    if (!unlock) return { message: "Another VS Code window is checking or installing an update." };
    let downloadDirectory;
    try {
      const state = await readState(directory);
      if (state.installedVersion && isNewer(state.installedVersion, manifest.version)) {
        return { reload: true, version: state.installedVersion, message: `CSV Table Editor ${state.installedVersion} is installed. Reload this window to use it.` };
      }
      const hours = Number(configuration().get("checkIntervalHours", 6));
      const delay = (Number.isFinite(hours) ? Math.max(1, Math.min(168, hours)) : 6) * HOUR;
      if (Number.isFinite(state.retryAt) && now() < state.retryAt) return { message: "GitHub requested a retry delay. Try again later." };
      if (!manual && Number.isFinite(state.lastAttempt) && now() - state.lastAttempt < delay) return {};
      const accessToken = await token();
      if (!accessToken) return { message: "Run CSV Table Editor: Configure Private Update Authentication to enable private updates." };
      // Persist BEFORE the request so network/auth failures and restarts are throttled.
      state.lastAttempt = now();
      state.retryAt = 0;
      await writeState(directory, state);
      try {
        log("Checking the private GitHub release.");
        const release = selectRelease(await client.latest(accessToken), manifest.version);
        if (!release) return { message: `CSV Table Editor ${manifest.version} is up to date (stable releases).` };
        if (disposed) return {};
        // Remove only our own interrupted download directories while holding the lock.
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (entry.isDirectory() && /^download-[0-9a-f-]{36}$/.test(entry.name)) {
            await fs.rm(path.join(directory, entry.name), { recursive: true, force: true });
          }
        }
        downloadDirectory = path.join(directory, `download-${randomUUID()}`);
        await fs.mkdir(downloadDirectory, { mode: 0o700 });
        const file = path.join(downloadDirectory, release.name);
        const expectedHash = parseChecksum(await client.checksum(release.checksum, accessToken), release.name);
        const actualHash = await client.download(release.vsix, accessToken, file);
        if (actualHash !== expectedHash) throw new UpdateError("The downloaded VSIX failed SHA-256 verification.");
        await verify(file, manifest, release.version);
        if (disposed || !manual && !configuration().get("enabled", true)) return {};
        log(`Installing verified version ${release.version} using the VS Code CLI.`);
        await install(file);
        state.installedVersion = release.version;
        await writeState(directory, state);
        log(`Version ${release.version} installed; reload required.`);
        return { reload: true, version: release.version, message: `CSV Table Editor ${release.version} installed. Reload this window to use the update.` };
      } catch (error) {
        if (error instanceof UpdateError && error.retryAt) {
          state.retryAt = error.retryAt;
          await writeState(directory, state);
        }
        throw error;
      }
    } finally {
      try { if (downloadDirectory) await fs.rm(downloadDirectory, { recursive: true, force: true }); }
      finally { await unlock(); }
    }
  }

  async function check(manual = false) {
    if (disposed) return;
    if (running) {
      if (manual) await vscode.window.showInformationMessage("CSV Table Editor is already checking for updates.");
      return;
    }
    running = (async () => {
      try {
        if (!supported()) {
          if (manual) await vscode.window.showInformationMessage("Private updates run in installed, local macOS/Windows extensions. Remote and Extension Development Hosts are skipped.");
          return;
        }
        if (!manual && !configuration().get("enabled", true)) return;
        const result = await checkLocked(manual);
        if (disposed) return;
        if (result.reload) {
          if (!manual && reloadNotifiedVersion === result.version) return;
          reloadNotifiedVersion = result.version;
          // Prompt after releasing the lock so an unanswered message cannot block other windows.
          const action = await vscode.window.showInformationMessage(result.message, "Reload Window", "Later");
          if (!disposed && action === "Reload Window") await vscode.commands.executeCommand("workbench.action.reloadWindow");
        } else if (manual && result.message) await vscode.window.showInformationMessage(result.message);
      } catch (error) {
        const message = error instanceof UpdateError ? error.message : "Private update failed. Check authentication, local storage access, and the VS Code installation.";
        log(message);
        if (manual && !disposed) {
          try { await vscode.window.showWarningMessage(message); } catch { /* Host is closing. */ }
        }
      }
    })();
    try { await running; } finally { running = undefined; }
  }

  async function configureAuthentication() {
    try {
      const choice = await vscode.window.showQuickPick([
        { label: "Fine-grained GitHub token", description: "Recommended: only this repository, Contents: Read-only", method: "token" },
        { label: "Sign in with GitHub", description: "VS Code manages authentication; requires the broader repo OAuth scope", method: "github" },
        { label: "Disconnect private updates", description: "Delete the saved token and stop using GitHub authentication for updates", method: "none" },
      ], { title: "CSV Table Editor: Private Update Authentication" });
      if (!choice || disposed) return;
      if (choice.method === "token") {
        const value = await vscode.window.showInputBox({ password: true, ignoreFocusOut: true,
          title: "GitHub token for Okamishimo/csv-table-editor", prompt: "Select only this repository with Contents: Read-only. Stored in VS Code SecretStorage.",
          validateInput: (input) => !input.trim() || /\s/.test(input.trim()) ? "Enter a non-empty token without whitespace." : undefined });
        if (!value?.trim() || disposed) return;
        await context.secrets.store(TOKEN_KEY, value.trim());
        await context.globalState.update(AUTH_KEY, "token");
      } else if (choice.method === "github") {
        await vscode.authentication.getSession("github", ["repo"], { createIfNone: true });
        await context.globalState.update(AUTH_KEY, "github");
        await context.secrets.delete(TOKEN_KEY);
      } else {
        await context.globalState.update(AUTH_KEY, "none");
        await context.secrets.delete(TOKEN_KEY);
      }
      await vscode.window.showInformationMessage(choice.method === "none" ? "Private update authentication disconnected." :
        "Private update authentication saved. Run CSV Table Editor: Check for Extension Updates to check now.");
    } catch {
      log("Private update authentication could not be configured.");
    }
  }

  function start() {
    startup = setTimeout(() => { void check(); }, 30000);
    interval = setInterval(() => { void check(); }, 5 * 60000);
    startup.unref?.();
    interval.unref?.();
  }
  function dispose() {
    disposed = true;
    clearTimeout(startup);
    clearInterval(interval);
    output.dispose();
  }
  return { check, configureAuthentication, start, dispose };
}

function activate(context, vscode) {
  const updater = createUpdater(context, vscode);
  context.subscriptions.push(updater,
    vscode.commands.registerCommand("csvTableEditor.checkForUpdates", () => updater.check(true)),
    vscode.commands.registerCommand("csvTableEditor.configureUpdateAuthentication", () => updater.configureAuthentication()));
  updater.start();
}

module.exports = { activate, createUpdater, acquireLock, readState, writeState, TOKEN_KEY, AUTH_KEY };
