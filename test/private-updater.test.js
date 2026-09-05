"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const test = require("node:test");
const { ZipFile } = require("yazl");
const { createUpdater, acquireLock, readState, writeState, TOKEN_KEY, AUTH_KEY } = require("../src/private-updater");
const { isNewer, selectRelease, parseChecksum, verifyVsixManifest, UpdateError } = require("../src/update-artifact");
const { cliInvocation, installVsix } = require("../src/update-installer");
const { releaseInfo, ensureAssetsAvailable } = require("../scripts/private-release");

async function zipManifest(manifest, name = "extension/package.json") {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), name);
  const chunks = [];
  const result = new Promise((resolve, reject) => {
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  zip.end();
  return result;
}

async function harness(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "csv-updater-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manifest = { name: "csv-table-editor", publisher: "Edgar-Dang", version: "0.0.10" };
  const payload = await zipManifest({ ...manifest, version: "0.0.11" });
  const hash = createHash("sha256").update(payload).digest("hex");
  const name = "csv-table-editor-0.0.11-enhanced.vsix";
  const checksum = `${hash}  ${name}\n`;
  const release = { tag_name: "v0.0.11", draft: false, prerelease: false, assets: [
    { id: 1, name, size: payload.length, state: "uploaded" },
    { id: 2, name: `${name}.sha256`, size: Buffer.byteLength(checksum), state: "uploaded" },
  ] };
  const values = new Map([[AUTH_KEY, "token"]]);
  const secrets = new Map([[TOKEN_KEY, "test-only-secret"]]);
  const messages = [];
  const logs = [];
  const installs = [];
  const authCalls = [];
  const executed = [];
  const config = { enabled: true, checkIntervalHours: 6 };
  const calls = { latest: 0, checksum: 0, download: 0 };
  let clock = 1800000000000;
  const context = {
    extension: { packageJSON: manifest, extensionKind: 2 }, extensionMode: 1,
    globalStorageUri: { fsPath: directory }, extensionUri: { fsPath: "/extensions/test" }, subscriptions: [],
    globalState: { get: (key) => values.get(key), update: async (key, value) => values.set(key, value) },
    secrets: { get: async (key) => secrets.get(key), store: async (key, value) => secrets.set(key, value), delete: async (key) => secrets.delete(key) },
  };
  const vscode = {
    ExtensionKind: { UI: 1, Workspace: 2 }, ExtensionMode: { Production: 1 }, env: {},
    workspace: { getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback }) },
    authentication: { getSession: async (...args) => { authCalls.push(args); return { accessToken: "managed-session" }; } },
    commands: { executeCommand: async (command) => executed.push(command) },
    window: {
      createOutputChannel: () => ({ appendLine: (message) => logs.push(message), dispose() {} }),
      showInformationMessage: async (message, ...actions) => { messages.push({ message, actions }); },
      showWarningMessage: async (message) => { messages.push({ message, warning: true }); },
      showQuickPick: async () => ({ method: "token" }), showInputBox: async () => "replacement-secret",
    },
  };
  const client = {
    latest: async (token) => { assert.ok(token); calls.latest++; return release; },
    checksum: async () => { calls.checksum++; return checksum; },
    download: async (asset, token, file) => { calls.download++; await fs.writeFile(file, payload); return hash; },
  };
  const dependencies = { client, now: () => clock, platform: "darwin", install: async (file) => {
    assert.deepEqual(await fs.readFile(file), payload);
    installs.push(file);
  }, ...overrides };
  const updater = createUpdater(context, vscode, dependencies);
  t.after(() => updater.dispose());
  return { updater, context, vscode, dependencies, client, config, values, secrets, release, messages, logs, installs, calls,
    authCalls, executed, directory, stateDirectory: path.join(directory, "private-updates"), payload,
    advance: (ms) => { clock += ms; } };
}

test("version checks compare numeric components and accept only stable release tags", () => {
  assert.equal(isNewer("0.0.10", "0.0.9"), true);
  assert.equal(isNewer("1.0.0", "1.0.0-rc.1"), true);
  assert.equal(isNewer("1.0.0", "1.0.0+build"), false);
  assert.equal(isNewer("1.0.0", "2.0.0"), false);
  for (const version of ["01.0.0", "1.0", "1.0.0-beta", "1.0.0/evil", "v1.0.0"]) assert.equal(isNewer(version, "0.0.1"), false);
});

test("release validation rejects ambiguous, unfinished and oversized assets", async (t) => {
  const h = await harness(t);
  assert.equal(selectRelease(h.release, "0.0.10").version, "0.0.11");
  assert.equal(selectRelease({ ...h.release, prerelease: true }, "0.0.10"), null);
  assert.equal(selectRelease({ ...h.release, draft: true }, "0.0.10"), null);
  assert.equal(selectRelease(h.release, "0.0.12"), null);
  assert.throws(() => selectRelease({ ...h.release, assets: [] }, "0.0.10"), /missing/);
  h.release.assets.push(h.release.assets[0]);
  assert.throws(() => selectRelease(h.release, "0.0.10"), /missing/);
  h.release.assets.pop();
  h.release.assets[0].size = 129 * 1024 * 1024;
  assert.throws(() => selectRelease(h.release, "0.0.10"), /missing/);
  assert.throws(() => parseChecksum(`${"a".repeat(64)}  different.vsix\n`, "expected.vsix"), /invalid/);
});

test("real ZIP validation checks identity, exact version, manifest bounds and corrupt data", async (t) => {
  const h = await harness(t);
  const file = path.join(h.directory, "artifact.zip");
  await fs.writeFile(file, h.payload);
  await verifyVsixManifest(file, h.context.extension.packageJSON, "0.0.11");
  await assert.rejects(verifyVsixManifest(file, h.context.extension.packageJSON, "0.0.12"), /manifest/);
  await assert.rejects(verifyVsixManifest(file, { publisher: "other", name: "csv-table-editor" }, "0.0.11"), /manifest/);
  await fs.writeFile(file, await zipManifest({ long: "x".repeat(70000) }));
  await assert.rejects(verifyVsixManifest(file, h.context.extension.packageJSON, "0.0.11"), /manifest/);
  await fs.writeFile(file, h.payload.subarray(0, -8));
  await assert.rejects(verifyVsixManifest(file, h.context.extension.packageJSON, "0.0.11"), /manifest/);
});

test("successful update downloads, validates, installs once, cleans up and offers Reload", async (t) => {
  const h = await harness(t);
  await h.updater.check();
  assert.equal(h.installs.length, 1);
  assert.equal((await readState(h.stateDirectory)).installedVersion, "0.0.11");
  assert.deepEqual(await fs.readdir(h.stateDirectory), ["state.json"]);
  assert.deepEqual(h.messages[0].actions, ["Reload Window", "Later"]);
  await h.updater.check();
  assert.equal(h.installs.length, 1);
  assert.equal(h.calls.latest, 1);
  assert.equal(h.messages.length, 1, "background polling must not repeatedly prompt for reload");
  h.vscode.window.showInformationMessage = async () => "Reload Window";
  await h.updater.check(true);
  assert.deepEqual(h.executed, ["workbench.action.reloadWindow"]);
  assert.doesNotMatch(h.logs.join("\n"), /test-only-secret/);
});

test("interval persists across hosts, throttles failures, and manual checks bypass it", async (t) => {
  const h = await harness(t);
  h.client.latest = async () => { h.calls.latest++; throw new Error("test-only-secret signed-url"); };
  await h.updater.check();
  assert.equal(h.calls.latest, 1);
  assert.equal(h.messages.length, 0, "background failure does not disturb editing");
  assert.doesNotMatch(h.logs.join("\n"), /test-only-secret|signed-url/);
  const other = createUpdater(h.context, h.vscode, h.dependencies);
  t.after(() => other.dispose());
  await other.check();
  assert.equal(h.calls.latest, 1);
  await other.check(true);
  assert.equal(h.calls.latest, 2);
  assert.equal(h.messages.at(-1).warning, true);
  h.advance(6 * 3600000);
  await other.check();
  assert.equal(h.calls.latest, 3);
});

test("rate-limit retry delay survives restarts and manual requests", async (t) => {
  const h = await harness(t);
  h.client.latest = async () => { h.calls.latest++; throw new UpdateError("rate limit", h.dependencies.now() + 3600000); };
  await h.updater.check();
  await h.updater.check(true);
  assert.equal(h.calls.latest, 1);
  h.advance(3600001);
  await h.updater.check(true);
  assert.equal(h.calls.latest, 2);
});

test("authentication is explicit, token is only stored in SecretStorage, OAuth background access is silent", async (t) => {
  const h = await harness(t);
  h.values.clear(); h.secrets.clear();
  await h.updater.check();
  assert.equal(h.calls.latest, 0);
  assert.equal(h.authCalls.length, 0);
  await h.updater.configureAuthentication();
  assert.equal(h.secrets.get(TOKEN_KEY), "replacement-secret");
  assert.equal(h.values.get(AUTH_KEY), "token");
  assert.doesNotMatch(JSON.stringify([...h.values]), /replacement-secret/);
  h.vscode.window.showQuickPick = async () => ({ method: "github" });
  await h.updater.configureAuthentication();
  assert.deepEqual(h.authCalls[0], ["github", ["repo"], { createIfNone: true }]);
  assert.equal(h.secrets.has(TOKEN_KEY), false);
  await h.updater.check();
  assert.deepEqual(h.authCalls[1], ["github", ["repo"], { silent: true }]);
  h.vscode.window.showQuickPick = async () => ({ method: "none" });
  await h.updater.configureAuthentication();
  assert.equal(h.values.get(AUTH_KEY), "none");
});

test("checksum mismatch, installer failure and disposal never mark an update installed", async (t) => {
  for (const failure of ["checksum", "install", "dispose"]) {
    const h = await harness(t);
    if (failure === "checksum") h.client.checksum = async () => `${"0".repeat(64)}  csv-table-editor-0.0.11-enhanced.vsix\n`;
    if (failure === "install") h.dependencies.install = async () => { throw new Error("private process details"); };
    const updater = failure === "install" ? createUpdater(h.context, h.vscode, h.dependencies) : h.updater;
    t.after(() => updater.dispose());
    if (failure === "dispose") {
      const latest = h.client.latest;
      h.client.latest = async () => { updater.dispose(); return latest("token"); };
    }
    await updater.check(true);
    assert.equal((await readState(h.stateDirectory)).installedVersion, undefined);
    assert.deepEqual(await fs.readdir(h.stateDirectory), ["state.json"]);
    assert.equal(h.installs.length, 0);
  }
});

test("cross-window lock allows one installer and is released after failure", async (t) => {
  const h = await harness(t);
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  h.client.latest = async () => { entered(); await new Promise((resolve) => { release = resolve; }); return h.release; };
  const first = h.updater.check();
  await ready;
  const other = createUpdater(h.context, h.vscode, h.dependencies);
  t.after(() => other.dispose());
  await other.check(true);
  assert.match(h.messages[0].message, /Another VS Code/);
  release(); await first;
  assert.equal(h.installs.length, 1);
  const unlock = await acquireLock(h.stateDirectory);
  assert.equal(typeof unlock, "function");
  await unlock();
});

test("disabled, remote and development hosts skip automatic update work", async (t) => {
  const h = await harness(t);
  h.config.enabled = false;
  await h.updater.check();
  assert.equal(h.calls.latest, 0);
  h.config.enabled = true;
  h.vscode.env.remoteName = "ssh-remote";
  await h.updater.check(true);
  assert.equal(h.calls.latest, 0);
  h.vscode.env.remoteName = undefined;
  h.context.extensionMode = 2;
  await h.updater.check(true);
  assert.equal(h.calls.latest, 0);
});

test("macOS/Windows CLI uses this app, separated arguments and correct user/extension directories", () => {
  for (const platform of ["darwin", "win32"]) {
    const root = platform === "darwin" ? "/Applications/Visual Studio Code.app/Contents/Resources/app" : "C:\\Program Files\\Microsoft VS Code\\resources\\app";
    const paths = platform === "darwin" ? path.posix : path.win32;
    const user = platform === "darwin" ? "/Users/name/Library/Application Support/Code" : "C:\\Users\\name\\AppData\\Roaming\\Code";
    const extensions = platform === "darwin" ? "/Users/name/.vscode/extensions" : "C:\\Users\\name\\.vscode\\extensions";
    const context = { extension: { extensionKind: 2 }, globalStorageUri: { fsPath: paths.join(user, "User/globalStorage/edgar-dang.csv-table-editor") },
      extensionUri: { fsPath: paths.join(extensions, "edgar-dang.csv-table-editor-0.0.10") } };
    const vscode = { env: { appRoot: root }, workspace: { getConfiguration: () => ({ get: () => "" }) }, ExtensionKind: { UI: 1 } };
    const file = paths.join(user, "spaces & symbols", "update.vsix");
    const result = cliInvocation(vscode, context, file, { nameShort: "Code" }, platform, { NODE_OPTIONS: "unsafe", VSCODE_IPC_HOOK_CLI: "remote" });
    assert.equal(result.executable, platform === "darwin" ? "/Applications/Visual Studio Code.app/Contents/MacOS/Code" : "C:\\Program Files\\Microsoft VS Code\\Code.exe");
    assert.deepEqual(result.args, [paths.join(root, "out/cli.js"), "--install-extension", file, "--force", "--user-data-dir", user, "--extensions-dir", extensions]);
    assert.equal(result.options.shell, false);
    assert.equal(result.options.env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(result.options.env.NODE_OPTIONS, undefined);
    assert.equal(result.options.env.VSCODE_IPC_HOOK_CLI, undefined);
    context.globalStorageUri.fsPath = paths.join(user, "User/profiles/abc/globalStorage/edgar-dang.csv-table-editor");
    assert.throws(() => cliInvocation(vscode, context, file, { nameShort: "Code" }, platform), /profileName/);
    vscode.workspace.getConfiguration = () => ({ get: () => "Personal Profile" });
    assert.deepEqual(cliInvocation(vscode, context, file, { nameShort: "Code" }, platform).args.slice(-2), ["--profile", "Personal Profile"]);
  }
});

test("installer errors do not expose child process output", async () => {
  await assert.rejects(installVsix({ env: { appRoot: "/missing-app" } }, {}, "unused"), /CLI installation failed/);
});

test("release script enforces exact stable tags and never replaces existing assets", () => {
  assert.equal(releaseInfo({ version: "0.0.10" }, "v0.0.10").name, "csv-table-editor-0.0.10-enhanced.vsix");
  for (const tag of ["v0.0.9", "0.0.10", "v0.0.10;echo bad"]) assert.throws(() => releaseInfo({ version: "0.0.10" }, tag), /match/);
  assert.throws(() => ensureAssetsAvailable({ assets: [{ name: "a.vsix" }] }, "a.vsix"), /Never overwrite/);
});
