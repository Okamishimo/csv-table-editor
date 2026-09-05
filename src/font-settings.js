"use strict";

const DEFAULT_FONT_FAMILY = "var(--vscode-font-family)";
const MAX_FONT_FAMILY_CHARS = 512;

function normalizeFontFamily(value) {
  if (typeof value !== "string") return DEFAULT_FONT_FAMILY;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_FONT_FAMILY_CHARS) : DEFAULT_FONT_FAMILY;
}

function getFontFamily(vscode) {
  const configured = vscode.workspace
    .getConfiguration("csvTableEditor")
    .get("fontFamily", "");
  return normalizeFontFamily(configured);
}

function watchFontFamily(vscode, webview) {
  if (typeof vscode.workspace.onDidChangeConfiguration !== "function") {
    return { dispose() {} };
  }
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("csvTableEditor.fontFamily")) {
      void webview.postMessage({ type: "fontFamily", fontFamily: getFontFamily(vscode) });
    }
  });
}

function replaceOnce(source, from, to, description) {
  const occurrences = source.split(from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Cannot add font setting support: expected one ${description}, found ${occurrences}.`);
  }
  return source.replace(from, to);
}

function decorateWebviewHtml(html) {
  if (html.includes("--csv-table-font-family")) return html;

  let decorated = replaceOnce(
    html,
    "font-family: var(--vscode-font-family);",
    "font-family: var(--csv-table-font-family, var(--vscode-font-family));",
    "body font declaration"
  );
  const script = `  function applyCsvTableFont(value) {
    const fontFamily = typeof value === 'string' && value.trim()
      ? value.trim()
      : 'var(--vscode-font-family)';
    document.documentElement.style.setProperty('--csv-table-font-family', fontFamily);
  }
  window.addEventListener('message', (event) => {
    if (event.data.type === 'init' || event.data.type === 'fontFamily') {
      applyCsvTableFont(event.data.fontFamily);
    }
  });
  applyCsvTableFont('');
`;
  decorated = replaceOnce(
    decorated,
    "  const encLabelEl = document.getElementById('enc-label');\n",
    "  const encLabelEl = document.getElementById('enc-label');\n" + script,
    "encoding label script anchor"
  );
  return decorated;
}

module.exports = {
  DEFAULT_FONT_FAMILY,
  decorateWebviewHtml,
  getFontFamily,
  normalizeFontFamily,
  watchFontFamily,
};
