"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { installStore, saveDocument } = require("../src/save-history");

function fixture() {
  const files = new Map();
  const uri = { scheme: "file", toString: () => "file:///data.csv" };
  const warnings = [];
  const vscode = {
    workspace: { fs: {
      async createDirectory() {},
      async writeFile(uri, bytes) { await new Promise(setImmediate); files.set(String(uri), Buffer.from(bytes)); },
      async delete(uri) { files.delete(String(uri)); },
    } },
    window: { showWarningMessage: (text) => warnings.push(text) },
  };
  const store = installStore({
    docDir: () => "history/data",
    indexFile: () => "history/data/index.json",
    snapFile: (_uri, id) => `history/data/${id}.snap`,
    async readIndex() {
      await new Promise(setImmediate);
      const bytes = files.get(this.indexFile(uri));
      return bytes ? JSON.parse(bytes) : { entries: [] };
    },
    async writeIndex(_uri, index) { await vscode.workspace.fs.writeFile(this.indexFile(uri), Buffer.from(JSON.stringify(index))); },
    async list() { return (await this.readIndex()).entries.sort((a, b) => b.ts - a.ts); },
  }, vscode);
  return { files, uri, vscode, store, warnings };
}

test("overlapping history writes retain every version, including same-millisecond saves", async (t) => {
  const { files, uri, store } = fixture();
  t.mock.method(Date, "now", () => 1234);
  const writes = Array.from({ length: 12 }, (_, n) => store.add(uri, Buffer.from(`version ${n}`), "utf8"));
  const listed = store.list(uri); // Opening history waits for the writes already requested.
  await Promise.all(writes);
  const entries = await listed;
  assert.equal(entries.length, 12);
  assert.equal(new Set(entries.map((e) => e.id)).size, 12);
  assert.deepEqual(entries.map((e) => files.get(store.snapFile(uri, e.id)).toString()),
    Array.from({ length: 12 }, (_, n) => `version ${11 - n}`));
});

test("rapid saves keep their own bytes even when serialization completes out of order", async () => {
  const { files, uri, store, vscode } = fixture();
  const replies = [];
  const document = { encodingKey: "utf8", serialize: () => new Promise((resolve) => replies.push(resolve)) };
  const first = saveDocument({ _history: store }, document, uri, {}, vscode);
  const second = saveDocument({ _history: store }, document, uri, {}, vscode);
  replies[1](Buffer.from("second"));
  replies[0](Buffer.from("first"));
  await Promise.all([first, second]);
  assert.equal(files.get(String(uri)).toString(), "second");
  const entries = await store.list(uri);
  assert.deepEqual(entries.map((e) => files.get(store.snapFile(uri, e.id)).toString()), ["second", "first"]);
});

test("cancelled and failed saves do not write snapshots or prevent later saves", async () => {
  const { files, uri, store, vscode } = fixture();
  const provider = { _history: store };
  const good = { encodingKey: "utf8", serialize: async () => Buffer.from("saved") };
  await saveDocument(provider, good, uri, { isCancellationRequested: true }, vscode);
  await assert.rejects(saveDocument(provider, { serialize: async () => { throw new Error("grid closed"); } }, uri, {}, vscode), /grid closed/);
  assert.equal(files.size, 0);
  await saveDocument(provider, good, uri, {}, vscode);
  assert.equal((await store.list(uri)).length, 1);
});

test("retention keeps the latest 50 versions and a failed index write deletes no old snapshots", async () => {
  const { files, uri, store } = fixture();
  await Promise.all(Array.from({ length: 52 }, (_, n) => store.add(uri, Buffer.from(String(n)), "utf8")));
  const entries = await store.list(uri);
  assert.equal(entries.length, 50);
  assert.equal(Array.from(files.keys()).filter((p) => p.endsWith(".snap")).length, 50);
  assert.equal(files.get(store.snapFile(uri, entries[0].id)).toString(), "51");
  const write = store.writeIndex;
  store.writeIndex = async () => { throw new Error("disk full"); };
  await assert.rejects(store.add(uri, Buffer.from("failed"), "utf8"), /disk full/);
  for (const entry of entries) assert.ok(files.has(store.snapFile(uri, entry.id)));
  store.writeIndex = write;
  await store.add(uri, Buffer.from("recovered"), "utf8");
  assert.equal((await store.list(uri)).length, 50);
});
