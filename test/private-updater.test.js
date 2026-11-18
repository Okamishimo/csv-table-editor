"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const test = require("node:test");
const { ZipFile } = require("yazl");
const { createUpdater, acquireLock, readState, writeState } = require("../src/private-updater");
const { isNewer, selectRelease, parseChecksum, verifyVsixManifest, UpdateError } = require("../src/update-artifact");
const { installVsix } = require("../src/update-installer");
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
  const { name: extensionName, publisher } = require("../package.json");
  const manifest = { name: extensionName, publisher, version: "0.0.10" };
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
    Uri: { file: (fsPath) => ({ scheme: "file", fsPath }) },
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

test("the independent extension rejects original-publisher updates even with a matching checksum", async (t) => {
  const h = await harness(t);
  const manifest = h.context.extension.packageJSON;
  assert.equal(`${manifest.publisher}.${manifest.name}`, "Okamishimo.csv-table-editor");
  assert.equal(Object.hasOwn(require("../package.json"), "__metadata"), false, "do not package metadata copied from an installed extension");
  const payload = await zipManifest({ ...manifest, publisher: "Edgar-Dang", version: "0.0.11" });
  const hash = createHash("sha256").update(payload).digest("hex");
  const checksum = `${hash}  ${h.release.assets[0].name}\n`;
  h.release.assets[0].size = payload.length;
  h.release.assets[1].size = Buffer.byteLength(checksum);
  h.client.checksum = async () => checksum;
  h.client.download = async (asset, file) => { await fs.writeFile(file, payload); return hash; };
  await h.updater.check(true);
  assert.equal(h.installs.length, 0);
  assert.equal((await readState(h.stateDirectory)).installedVersion, undefined);
  assert.deepEqual(await fs.readdir(h.stateDirectory), ["state.json"]);
  assert.equal(h.messages[0].warning, true);
  assert.match(h.messages[0].message, /extension identity/);
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
    h.values.set("privateUpdates.authMethod", method);
    h.secrets.set("privateUpdates.githubToken", "expired-legacy-secret");
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

test("macOS/Windows installation passes a VSIX URI to the official command without CLI or profile lookup", async () => {
  for (const platform of ["darwin", "win32"]) {
    const file = platform === "darwin" ? "/Users/name/updates & files/更新.vsix" : "c:\\Users\\AIRCh\\updates & files\\更新.vsix";
    for (const profile of ["User", "User/profiles/abc"]) {
      const uri = { scheme: "file", fsPath: file };
      const calls = [];
      const vscode = {
        env: { get appRoot() { throw new Error("must not locate the executable or product.json"); } },
        ExtensionKind: { UI: 1 }, ExtensionMode: { Production: 1 },
        workspace: { getConfiguration() { throw new Error("must not require a profile name"); } },
        Uri: { file: (value) => { assert.equal(value, file); return uri; } },
        commands: { executeCommand: async (...args) => { calls.push(args); } },
      };
      const context = { extension: { extensionKind: 2 }, extensionMode: 1,
        globalStorageUri: { fsPath: `${profile}/globalStorage/editor` } };
      await installVsix(vscode, context, file, platform);
      assert.deepEqual(calls, [["workbench.extensions.installExtension", uri]]);
      assert.equal(calls[0][1], uri, "a path string would be interpreted as a Marketplace extension ID");
    }
  }
});

test("built-in installation retains the local production macOS/Windows guards", async () => {
  for (const { platform = "darwin", remoteName, extensionMode = 1 } of [
    { platform: "linux" }, { remoteName: "ssh-remote" }, { remoteName: "wsl" },
    { extensionMode: 2 }, { extensionMode: 3 },
  ]) {
    const vscode = { env: { remoteName }, ExtensionKind: { UI: 1 }, ExtensionMode: { Production: 1 },
      commands: { executeCommand() { assert.fail("unsupported hosts must not install"); } } };
    const context = { extension: { extensionKind: 2 }, extensionMode };
    await assert.rejects(installVsix(vscode, context, "unused.vsix", platform), /installed, local macOS and Windows/);
  }
});

test("built-in installation waits for completion before marking success, cleaning up and offering Reload", async (t) => {
  for (const platform of ["darwin", "win32"]) {
    const h = await harness(t);
    let entered;
    let finish;
    let vsix;
    const started = new Promise((resolve) => { entered = resolve; });
    const held = new Promise((resolve) => { finish = resolve; });
    const calls = [];
    h.vscode.commands.executeCommand = async (command, uri) => {
      calls.push(command);
      vsix = uri.fsPath;
      entered();
      assert.equal(command, "workbench.extensions.installExtension");
      assert.equal(uri.scheme, "file");
      assert.deepEqual(await fs.readFile(vsix), h.payload);
      await held;
    };
    const dependencies = { ...h.dependencies, install: undefined, platform };
    const updater = createUpdater(h.context, h.vscode, dependencies);
    const other = createUpdater(h.context, h.vscode, dependencies);
    t.after(() => { updater.dispose(); other.dispose(); });
    const pending = updater.check(true);
    await started;
    try {
      assert.equal((await readState(h.stateDirectory)).installedVersion, undefined);
      await fs.access(vsix);
      assert.equal(h.messages.length, 0, "no reload prompt while installation is pending");
      await other.check(true);
      assert.match(h.messages[0].message, /Another VS Code/);
      assert.deepEqual(calls, ["workbench.extensions.installExtension"]);
    } finally {
      finish();
      await pending;
    }
    assert.equal((await readState(h.stateDirectory)).installedVersion, "0.0.11");
    assert.deepEqual(await fs.readdir(h.stateDirectory), ["state.json"]);
    assert.deepEqual(h.messages.at(-1).actions, ["Reload Window", "Later"]);
    assert.match(h.logs.join("\n"), /built-in extension installation command/);
    await updater.check();
    assert.equal(calls.length, 1, "a completed installation must not be repeated");
  }
});

test("installer reports command errors and cancellation without exposing credentials", async (t) => {
  const cases = [
    { error: new Error("Extension requires VS Code 1.100 or newer."), expected: /installation failed\.\nExtension requires VS Code 1.100 or newer/ },
    { error: new Error("command 'workbench.extensions.installExtension' not found"), expected: /installExtension.*not found/ },
    { error: Object.assign(new Error("Installation cancelled"), { code: "Canceled" }), expected: /code Canceled.*\nInstallation cancelled/ },
    { error: new Error("\u001b[31mPermission denied\u001b[0m\nAuthorization: Bearer secret-value\nhttps://example.com/file?signature=private-value\ntoken=other-secret github_pat_abcdef ghp_abcdef"),
      expected: /Permission denied/, absent: /secret-value|private-value|other-secret|github_pat_abcdef|ghp_abcdef|\u001b/ },
    { error: new Error("Disk full. " + "x".repeat(5000)), expected: /Disk full.*\n\[truncated\]/ },
    { error: "Installation rejected", expected: /Installation rejected/ },
  ];
  for (const entry of cases) {
    const h = await harness(t);
    h.vscode.commands.executeCommand = async () => { throw entry.error; };
    await assert.rejects(installVsix(h.vscode, h.context, "unused.vsix", "darwin"), (error) => {
      assert.ok(error instanceof UpdateError);
      assert.match(error.message, entry.expected);
      if (entry.absent) assert.doesNotMatch(error.message, entry.absent);
      assert.ok(error.message.length <= 4012);
      return true;
    });
  }
});

test("actual command failures reach manual warnings and background logs without marking installation complete", async (t) => {
  for (const manual of [true, false]) {
    const h = await harness(t);
    h.vscode.commands.executeCommand = async () => {
      throw Object.assign(new Error("Cannot install extension: incompatible VS Code version. token=private-value"), { code: "Incompatible" });
    };
    const dependencies = { ...h.dependencies, install: undefined };
    const updater = createUpdater(h.context, h.vscode, dependencies);
    t.after(() => updater.dispose());
    await updater.check(manual);
    assert.match(h.logs.join("\n"), /code Incompatible.*\nCannot install extension: incompatible VS Code version/);
    if (manual) {
      assert.equal(h.messages[0].warning, true);
      assert.match(h.messages[0].message, /Cannot install extension: incompatible VS Code version/);
    } else assert.equal(h.messages.length, 0);
    assert.doesNotMatch(JSON.stringify([h.logs, h.messages]), /private-value/);
    assert.equal((await readState(h.stateDirectory)).installedVersion, undefined);
    assert.deepEqual(await fs.readdir(h.stateDirectory), ["state.json"]);
    const restarted = createUpdater(h.context, h.vscode, dependencies);
    t.after(() => restarted.dispose());
    await restarted.check();
    assert.equal(h.calls.latest, 1, "failed command installations remain throttled across restarts");
    h.vscode.commands.executeCommand = async () => {};
    await restarted.check(true);
    assert.equal((await readState(h.stateDirectory)).installedVersion, "0.0.11", "manual retry can finish the installation");
  }
});

test("release script enforces exact stable tags and never replaces existing assets", () => {
  assert.equal(releaseInfo({ version: "0.0.10" }, "v0.0.10").name, "csv-table-editor-0.0.10-enhanced.vsix");
  for (const tag of ["v0.0.9", "0.0.10", "v0.0.10;echo bad"]) assert.throws(() => releaseInfo({ version: "0.0.10" }, tag), /match/);
  assert.throws(() => ensureAssetsAvailable({ assets: [{ name: "a.vsix" }] }, "a.vsix"), /Never overwrite/);
});
