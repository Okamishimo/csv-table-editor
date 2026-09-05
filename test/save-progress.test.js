"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  GRID_REQUEST_TIMEOUT_MS,
  PROGRESS_DELAY_MS,
  requestGridData,
  withSaveProgress,
} = require("../src/save-progress");

/** A stand-in for CsvEditorProvider carrying only what the hook touches. */
function fakeProvider({ withPanel = true } = {}) {
  const posted = [];
  const disposeListeners = [];
  const panel = {
    onDidDispose(listener) {
      disposeListeners.push(listener);
      return { dispose() { disposeListeners.splice(disposeListeners.indexOf(listener), 1); } };
    },
  };
  const document = { uri: { path: "/tmp/data.csv" } };
  const provider = {
    _panels: new Map(withPanel ? [[document, panel]] : []),
    _pendingGridRequests: new Map(),
    _requestSeq: 0,
    post(target, message) { posted.push({ target, message }); },
  };
  const reply = (grid) => {
    const request = posted.at(-1).message;
    const resolve = provider._pendingGridRequests.get(request.requestId);
    provider._pendingGridRequests.delete(request.requestId);
    resolve(grid);
  };
  const closePanel = () => { for (const listener of [...disposeListeners]) listener(); };
  return { provider, document, panel, posted, reply, closePanel, disposeListeners };
}

function fakeVscode() {
  const progresses = [];
  return {
    progresses,
    ProgressLocation: { Window: 10, Notification: 15 },
    window: {
      withProgress(options, task) {
        const entry = { options, done: false };
        progresses.push(entry);
        return Promise.resolve(task({ report() {} })).then(
          (value) => { entry.done = true; return value; },
          (error) => { entry.done = true; throw error; }
        );
      },
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a grid request resolves with what the webview actually sent", async () => {
  const { provider, document, posted, reply } = fakeProvider();
  const pending = requestGridData(provider, document, fakeVscode());
  assert.equal(posted.length, 1);
  assert.equal(posted[0].message.type, "requestGridData");

  reply([["a", "b"], ["1", "2"]]);
  assert.deepEqual(await pending, [["a", "b"], ["1", "2"]]);
  assert.equal(provider._pendingGridRequests.size, 0, "the request is not left pending");
});

test("a missing panel fails the save instead of answering with an empty grid", async () => {
  const { provider, document } = fakeProvider({ withPanel: false });
  await assert.rejects(
    requestGridData(provider, document, fakeVscode()),
    (error) => {
      assert.equal(error.code, "CSV_TABLE_EDITOR_GRID_UNAVAILABLE");
      assert.match(error.message, /left unchanged/);
      return true;
    }
  );
});

test("closing the grid while a save waits fails the save, and never truncates", async () => {
  const { provider, document, closePanel } = fakeProvider();
  const pending = requestGridData(provider, document, fakeVscode());
  closePanel();
  await assert.rejects(pending, /closed before its contents could be read/);
  assert.equal(provider._pendingGridRequests.size, 0);
});

test("a webview that never answers times out into a failure, not an empty file", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { provider, document } = fakeProvider();
  const pending = requestGridData(provider, document, fakeVscode());
  let settled = null;
  pending.then(() => { settled = "resolved"; }, () => { settled = "rejected"; });

  t.mock.timers.tick(GRID_REQUEST_TIMEOUT_MS - 1000);
  await Promise.resolve();
  assert.equal(settled, null, "a slow save is given time rather than cut short");

  t.mock.timers.tick(2000);
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "CSV_TABLE_EDITOR_GRID_UNAVAILABLE");
    assert.match(error.message, /did not return its contents/);
    assert.match(error.message, /left unchanged/);
    return true;
  });
});

test("a late reply after a timeout cannot resolve the abandoned request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { provider, document } = fakeProvider();
  const pending = requestGridData(provider, document, fakeVscode());
  pending.catch(() => {});
  t.mock.timers.tick(GRID_REQUEST_TIMEOUT_MS + 1);
  await assert.rejects(pending);
  assert.equal(provider._pendingGridRequests.size, 0,
    "the resolver is removed, so a late gridData message is ignored");
});

test("a quick save says nothing", async () => {
  const vscode = fakeVscode();
  const result = await withSaveProgress(vscode, { path: "/tmp/data.csv" }, async () => "saved");
  assert.equal(result, "saved");
  await tick();
  assert.equal(vscode.progresses.length, 0, "no indicator for a save the user cannot notice");
});

test("a slow save reports itself in the status bar and clears when it finishes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const vscode = fakeVscode();
  let finish;
  const pending = withSaveProgress(vscode, { path: "/a/b/report.csv" },
    () => new Promise((resolve) => { finish = resolve; }));

  await Promise.resolve();
  assert.equal(vscode.progresses.length, 0, "nothing yet");
  t.mock.timers.tick(PROGRESS_DELAY_MS + 1);
  await Promise.resolve();

  assert.equal(vscode.progresses.length, 1);
  assert.equal(vscode.progresses[0].options.location, vscode.ProgressLocation.Window);
  assert.equal(vscode.progresses[0].options.title, "Saving report.csv…");
  assert.equal(vscode.progresses[0].done, false);

  finish("written");
  assert.equal(await pending, "written");
  await tick();
  assert.equal(vscode.progresses[0].done, true, "the indicator follows the work");
});

test("a failed slow save clears its indicator and still reports the failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const vscode = fakeVscode();
  let fail;
  const pending = withSaveProgress(vscode, { path: "/a/b/report.csv" },
    () => new Promise((resolve, reject) => { fail = reject; }));
  pending.catch(() => {});

  t.mock.timers.tick(PROGRESS_DELAY_MS + 1);
  await Promise.resolve();
  assert.equal(vscode.progresses.length, 1);

  fail(new Error("disk full"));
  await assert.rejects(pending, /disk full/);
  await tick();
  assert.equal(vscode.progresses[0].done, true, "the indicator must not outlive a failed save");
});

test("an untitled document still gets a usable indicator title", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const vscode = fakeVscode();
  let finish;
  const pending = withSaveProgress(vscode, undefined, () => new Promise((r) => { finish = r; }));
  t.mock.timers.tick(PROGRESS_DELAY_MS + 1);
  await Promise.resolve();
  assert.equal(vscode.progresses[0].options.title, "Saving CSV file…");
  finish();
  await pending;
});
