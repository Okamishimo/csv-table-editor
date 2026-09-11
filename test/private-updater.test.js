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
  const values = new Map();
  const secrets = new Map();
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
    latest: async (...args) => { assert.deepEqual(args, []); calls.latest++; return release; },
    checksum: async (...args) => { assert.deepEqual(args, [release.assets[1]]); calls.checksum++; return checksum; },
    download: async (asset, file) => { calls.download++; await fs.writeFile(file, payload); return hash; },
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

test("public updates install without authentication, including legacy token, OAuth and disconnected profiles", async (t) => {
  for (const method of [undefined, "token", "github", "none"]) {
    const h = await harness(t);
    h.values.set(AUTH_KEY, method);
    h.secrets.set(TOKEN_KEY, "expired-legacy-secret");
    h.context.secrets.get = async () => { throw new Error("must not read old credentials"); };
    h.vscode.authentication.getSession = async () => { throw new Error("must not request a session"); };
    h.vscode.window.showQuickPick = h.vscode.window.showInputBox = async () => { throw new Error("must not prompt for authentication"); };
    await h.updater.check(true);
    assert.equal(h.calls.latest, 1);
    assert.equal(h.calls.checksum, 1);
    assert.equal(h.installs.length, 1);
    assert.doesNotMatch(JSON.stringify([...h.messages, ...h.logs]), /expired-legacy-secret/);
  }
});

test("legacy authentication command removes credentials without disabling public updates or signing out GitHub", async (t) => {
  const h = await harness(t);
  h.values.set(AUTH_KEY, "token");
  h.secrets.set(TOKEN_KEY, "expired-legacy-secret");
  await h.updater.configureAuthentication();
  assert.equal(h.secrets.has(TOKEN_KEY), false);
  assert.equal(h.values.get(AUTH_KEY), undefined);
  assert.equal(h.authCalls.length, 0);
  assert.equal(h.config.enabled, true);
  assert.match(h.messages[0].message, /cleared.*do not require/);
  await h.updater.check();
  assert.equal(h.installs.length, 1);
});

test("legacy credential cleanup failure is sanitized and does not block public updates", async (t) => {
  const h = await harness(t);
  h.context.secrets.delete = async () => { throw new Error("secret-storage-details"); };
  await h.updater.configureAuthentication();
  assert.equal(h.messages[0].warning, true);
  assert.doesNotMatch(JSON.stringify([...h.messages, ...h.logs]), /secret-storage-details/);
  await h.updater.check();
  assert.equal(h.installs.length, 1);
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
      h.client.latest = async () => { updater.dispose(); return latest(); };
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

async function failingInstaller(h, error) {
  const appRoot = path.join(h.directory, "Code.app", "Contents", "Resources", "app");
  await fs.mkdir(path.join(appRoot, "out"), { recursive: true });
  await fs.writeFile(path.join(appRoot, "product.json"), JSON.stringify({ nameShort: "Code" }));
  const vscode = { ...h.vscode, env: { appRoot } };
  const context = { ...h.context, globalStorageUri: { fsPath: path.join(h.directory, "User", "globalStorage", "editor") } };
  const invocation = cliInvocation(vscode, context, "unused", { nameShort: "Code" }, "darwin");
  await fs.mkdir(path.dirname(invocation.executable), { recursive: true });
  await fs.writeFile(invocation.executable, "");
  await fs.writeFile(invocation.args[0], "");
  return (file) => installVsix(vscode, context, file, async () => { throw error; }, "darwin");
}

test("installer reports CLI diagnostics, exit status and launch errors without exposing credentials", async (t) => {
  const cases = [
    { error: Object.assign(new Error("Command failed: internal invocation"), {
      code: 1, stderr: "Warning: installation failed", stdout: "Extension requires VS Code 1.100 or newer.",
    }), expected: /code 1.*\nWarning: installation failed\nExtension requires VS Code 1.100 or newer/, absent: /internal invocation/ },
    { error: Object.assign(new Error("spawn Code EACCES"), { code: "EACCES" }), expected: /EACCES.*\nspawn Code EACCES/ },
    { error: Object.assign(new Error("Command failed"), { code: null, killed: true, signal: "SIGTERM", stderr: "Installation interrupted" }),
      expected: /SIGTERM.*timeout or cancellation.*\nInstallation interrupted/, absent: /code null|code ,/ },
    { error: Object.assign(new Error("Command failed"), { stderr: "\u001b[31mPermission denied\u001b[0m\nAuthorization: Bearer secret-value\nhttps://example.com/file?signature=private-value\ntoken=other-secret github_pat_abcdef ghp_abcdef" }),
      expected: /Permission denied/, absent: /secret-value|private-value|other-secret|github_pat_abcdef|ghp_abcdef|\u001b/ },
    { error: Object.assign(new Error("Command failed"), { stdout: "Disk full. " + "x".repeat(5000) }), expected: /Disk full.*\n\[truncated\]/ },
  ];
  for (const entry of cases) {
    const h = await harness(t);
    const install = await failingInstaller(h, entry.error);
    await assert.rejects(install("unused.vsix"), (error) => {
      assert.ok(error instanceof UpdateError);
      assert.match(error.message, entry.expected);
      if (entry.absent) assert.doesNotMatch(error.message, entry.absent);
      assert.ok(error.message.length <= 4012);
      return true;
    });
  }
  await assert.rejects(installVsix({ env: { appRoot: "/missing-app" } }, {}, "unused"), /CLI installation failed.*ENOENT.*\n.*product.json/);
});

test("actual installer diagnostics reach manual warnings and background logs without marking installation complete", async (t) => {
  for (const manual of [true, false]) {
    const h = await harness(t);
    const install = await failingInstaller(h, Object.assign(new Error("Command failed"), {
      code: 1, stderr: "Cannot install extension: incompatible VS Code version.",
    }));
    const updater = createUpdater(h.context, h.vscode, { ...h.dependencies, install });
    t.after(() => updater.dispose());
    await updater.check(manual);
    assert.match(h.logs.join("\n"), /code 1.*\nCannot install extension: incompatible VS Code version/);
    if (manual) {
      assert.equal(h.messages[0].warning, true);
      assert.match(h.messages[0].message, /Cannot install extension: incompatible VS Code version/);
    } else assert.equal(h.messages.length, 0);
    assert.equal((await readState(h.stateDirectory)).installedVersion, undefined);
    assert.deepEqual(await fs.readdir(h.stateDirectory), ["state.json"]);
  }
});

test("release script enforces exact stable tags and never replaces existing assets", () => {
  assert.equal(releaseInfo({ version: "0.0.10" }, "v0.0.10").name, "csv-table-editor-0.0.10-enhanced.vsix");
  for (const tag of ["v0.0.9", "0.0.10", "v0.0.10;echo bad"]) assert.throws(() => releaseInfo({ version: "0.0.10" }, tag), /match/);
  assert.throws(() => ensureAssetsAvailable({ assets: [{ name: "a.vsix" }] }, "a.vsix"), /Never overwrite/);
});
