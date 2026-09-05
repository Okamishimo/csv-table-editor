"use strict";

/**
 * Saving the editable grid asks the Webview for its contents and waits for the
 * reply, because the grid, not the extension host, holds the current data.
 *
 * The shipped implementation gave up after five seconds and resolved with an
 * empty grid. An empty grid serializes to an empty string, so a Webview that
 * was merely busy caused the user's file to be overwritten with nothing. The
 * same happened whenever the panel could not be found. That is the one outcome
 * a save must never produce.
 *
 * A save may take as long as it needs. What it must not do is write something
 * that is not the document's contents, so a request that cannot be answered
 * fails loudly and leaves the file alone. Because the wait is now unbounded in
 * practice, a save that takes long enough to notice says so in the status bar.
 */

/**
 * Long enough that no legitimate save is cut short, short enough that a Webview
 * which will never answer does not leave the editor waiting forever.
 */
const GRID_REQUEST_TIMEOUT_MS = 120000;

/** Quick saves stay silent; only ones the user would notice announce themselves. */
const PROGRESS_DELAY_MS = 400;

/** A save that could not read the grid. The file is left untouched. */
class GridUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "GridUnavailableError";
    this.code = "CSV_TABLE_EDITOR_GRID_UNAVAILABLE";
  }
}

/**
 * Ask the Webview for the grid. Resolves only with data the Webview actually
 * sent; every other outcome rejects.
 */
function requestGridData(provider, document, vscode) {
  const panel = provider._panels.get(document);
  if (!panel) {
    return Promise.reject(new GridUnavailableError(
      "The CSV grid view is not open, so its contents could not be read. " +
      "The file was left unchanged; reopen it and try again."
    ));
  }

  const requestId = ++provider._requestSeq;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let subscription = null;

    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (subscription) subscription.dispose();
      provider._pendingGridRequests.delete(requestId);
      settle(value);
    };

    provider._pendingGridRequests.set(requestId, (grid) => finish(resolve, grid));

    timer = setTimeout(() => finish(reject, new GridUnavailableError(
      `The CSV grid did not return its contents within ${Math.round(GRID_REQUEST_TIMEOUT_MS / 1000)} seconds. ` +
      "The file was left unchanged."
    )), GRID_REQUEST_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    if (typeof panel.onDidDispose === "function") {
      subscription = panel.onDidDispose(() => finish(reject, new GridUnavailableError(
        "The CSV grid view was closed before its contents could be read. " +
        "The file was left unchanged."
      )));
    }

    try {
      provider.post(panel, { type: "requestGridData", requestId });
    } catch (error) {
      finish(reject, error);
    }
  });
}

/**
 * Run a save, reporting it in the status bar once it takes long enough to be
 * worth mentioning. The indicator follows the work, so it disappears on its own
 * whether the save succeeds or fails.
 */
function withSaveProgress(vscode, uri, run) {
  const work = Promise.resolve().then(run);
  const timer = setTimeout(() => {
    void vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Saving ${fileName(uri)}…`,
      },
      // The progress ends with the save; a failure is reported by the caller.
      () => work.then(() => undefined, () => undefined)
    );
  }, PROGRESS_DELAY_MS);
  if (typeof timer.unref === "function") timer.unref();

  const stop = () => clearTimeout(timer);
  return work.then(
    (value) => { stop(); return value; },
    (error) => { stop(); throw error; }
  );
}

function fileName(uri) {
  const path = uri && typeof uri.path === "string" ? uri.path : "";
  return path.split("/").pop() || "CSV file";
}

module.exports = {
  GRID_REQUEST_TIMEOUT_MS,
  GridUnavailableError,
  PROGRESS_DELAY_MS,
  requestGridData,
  withSaveProgress,
};
