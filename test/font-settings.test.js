"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DEFAULT_FONT_FAMILY,
  decorateWebviewHtml,
  getFontFamily,
  normalizeFontFamily,
  watchFontFamily,
} = require("../src/font-settings");

test("font setting accepts arbitrary CSS font-family values", () => {
  const configured = '"Microsoft JhengHei", "Noto Sans TC", sans-serif';
  const vscode = {
    workspace: {
      getConfiguration: () => ({ get: () => configured }),
    },
  };

  assert.equal(getFontFamily(vscode), configured);
  assert.equal(normalizeFontFamily("  My Installed Font, serif  "), "My Installed Font, serif");
  assert.equal(normalizeFontFamily(""), DEFAULT_FONT_FAMILY);
  assert.equal(normalizeFontFamily(null), DEFAULT_FONT_FAMILY);
  assert.equal(normalizeFontFamily("x".repeat(600)).length, 512);
});

test("font setting watcher updates an open webview", () => {
  let listener;
  let configured = "Consolas, monospace";
  const messages = [];
  const vscode = {
    workspace: {
      getConfiguration: () => ({ get: () => configured }),
      onDidChangeConfiguration: (callback) => {
        listener = callback;
        return { dispose() {} };
      },
    },
  };
  const subscription = watchFontFamily(vscode, {
    postMessage: (message) => messages.push(message),
  });

  listener({ affectsConfiguration: () => false });
  assert.equal(messages.length, 0);
  configured = "Custom CSV Font";
  listener({ affectsConfiguration: (key) => key === "csvTableEditor.fontFamily" });
  assert.deepEqual(messages, [{ type: "fontFamily", fontFamily: "Custom CSV Font" }]);
  subscription.dispose();
});

test("editable grid decorator applies font values received from settings once", () => {
  const html = `<style>
  body { font-family: var(--vscode-font-family); }
</style>
<script>
  const encLabelEl = document.getElementById('enc-label');
</script>`;

  const decorated = decorateWebviewHtml(html);
  assert.match(decorated, /--csv-table-font-family/);
  assert.match(decorated, /event\.data\.fontFamily/);
  assert.doesNotMatch(decorated, /id="font-family"/);
  assert.equal(decorateWebviewHtml(decorated), decorated);
});
