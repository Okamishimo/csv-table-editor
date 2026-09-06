"use strict";

const { randomBytes } = require("node:crypto");

// Share queues across stores in this extension host, keyed by their actual
// destination. A failed operation must not poison subsequent saves or reads.
const queues = new Map();
function enqueue(key, run) {
  const work = (queues.get(key) || Promise.resolve()).then(run);
  const tail = work.then(() => undefined, () => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return work;
}

function installStore(store, vscode) {
  const list = store.list.bind(store);
  const key = (uri) => store.indexFile(uri).toString();
  store.add = (uri, bytes, encodingKey) => enqueue(key(uri), async () => {
    await vscode.workspace.fs.createDirectory(store.docDir(uri));
    const index = await store.readIndex(uri);
    const ts = Date.now();
    const id = `${ts}-${randomBytes(8).toString("hex")}`;
    await vscode.workspace.fs.writeFile(store.snapFile(uri, id), bytes);
    // Insert before equal timestamps, so rapid saves remain newest-first.
    index.entries.unshift({ id, ts, encodingKey, size: bytes.byteLength });
    const expired = index.entries.splice(50);
    // Publish the new index before deleting any snapshots it used to reference.
    await store.writeIndex(uri, index);
    for (const entry of expired) {
      try { await vscode.workspace.fs.delete(store.snapFile(uri, entry.id)); } catch {}
    }
  });
  store.list = (uri) => enqueue(key(uri), () => list(uri));
  return store;
}

function saveDocument(provider, document, uri, token, vscode) {
  // Request this save's grid now, before waiting on earlier disk writes. Retain
  // the exact serialized bytes for history instead of rereading a changing file.
  const content = document.serialize();
  const encodingKey = document.encodingKey;
  // Observe failures immediately even while this save is waiting in the queue.
  const result = content.then((bytes) => ({ bytes }), (error) => ({ error }));
  return enqueue(`save:${uri.toString()}`, async () => {
    const snapshot = await result;
    if (snapshot.error) throw snapshot.error;
    if (token.isCancellationRequested) return;
    await vscode.workspace.fs.writeFile(uri, snapshot.bytes);
    if (uri.scheme === "untitled") return;
    try {
      await provider._history.add(uri, snapshot.bytes, encodingKey);
    } catch (error) {
      console.error("CSV history: failed to store snapshot", error);
      void vscode.window.showWarningMessage("The CSV was saved, but its history version could not be stored.");
    }
  });
}

module.exports = { installStore, saveDocument };
