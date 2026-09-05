"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const iconv = require("iconv-lite");
const { JSDOM } = require("jsdom");
const { SEARCH_DEBOUNCE_MS } = require("../src/grid-performance");

/** Wait past the grid's filter debounce so a typed query has been applied. */
function settleSearch() {
  return new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 60));
}

function loadBundleInternals(vscodeStub = {}) {
  const bundlePath = path.join(__dirname, "..", "dist", "extension.js");
  const source = fs.readFileSync(bundlePath, "utf8");
  const marker = "module.exports=i})();";
  assert.equal(source.split(marker).length - 1, 1, "webpack export marker changed");

  const instrumented = source.replace(marker, "i.__testRequire=n,module.exports=i})();");
  const extensionModule = new Module(path.join(path.dirname(bundlePath), "extension.integration.js"), module);
  extensionModule.filename = path.join(path.dirname(bundlePath), "extension.integration.js");
  extensionModule.paths = Module._nodeModulePaths(path.dirname(bundlePath));

  const originalLoad = Module._load;
  Module._load = function loadWithVscodeStub(request, parent, isMain) {
    if (request === "vscode") return vscodeStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    extensionModule._compile(instrumented, extensionModule.filename);
  } finally {
    Module._load = originalLoad;
  }
  return extensionModule.exports.__testRequire;
}

test("patched distribution uses the enhanced detector", () => {
  const webpackRequire = loadBundleInternals();
  const encoding = webpackRequire(999);

  const big5 = iconv.encode("姓名,城市\r\n王小明,臺北\r\n繁體中文,高雄\r\n", "big5");
  const shiftJis = iconv.encode("名前,都市\r\n山田太郎,東京\r\n日本語,大阪\r\n", "shiftjis");

  assert.equal(encoding.detectEncoding(big5), "big5");
  assert.equal(encoding.detectEncoding(shiftJis), "shiftjis");
  assert.equal(encoding.findEncoding("utf16le").label, "UTF-16 LE (no BOM)");
  assert.equal(encoding.findEncoding("utf16be-bom").label, "UTF-16 BE with BOM");
});

test("patched editable grid follows the free-form font setting live", async () => {
  const postedMessages = [];
  let configuredFont = '"Microsoft JhengHei", sans-serif';
  let configurationListener;
  const vscode = {
    workspace: {
      getConfiguration: () => ({
        get: (key, fallback) => key === "fontFamily" ? configuredFont : fallback,
      }),
      onDidChangeConfiguration: (listener) => {
        configurationListener = listener;
        return { dispose() {} };
      },
    },
  };
  const webpackRequire = loadBundleInternals(vscode);
  const providerType = webpackRequire(248).CsvEditorProvider;
  const provider = Object.create(providerType.prototype);
  provider._context = { extensionUri: {} };
  provider._panels = new Map();
  provider._pendingGridRequests = new Map();
  const document = {
    initialText: "name,city\nAlice,Taipei",
    encodingKey: "utf8",
    uri: { path: "/font.csv" },
    onDidChangeContent: () => ({ dispose() {} }),
  };
  let receiveMessage;
  const panel = {
    webview: {
      options: {},
      html: "",
      postMessage: async (message) => postedMessages.push(message),
      onDidReceiveMessage: (listener) => {
        receiveMessage = listener;
        return { dispose() {} };
      },
    },
    onDidDispose: () => ({ dispose() {} }),
  };

  await provider.resolveCustomEditor(document, panel, null);
  assert.doesNotMatch(panel.webview.html, /id="font-family"/);
  assert.match(panel.webview.html, /--csv-table-font-family/);

  const webviewMessages = [];
  const dom = new JSDOM(panel.webview.html, {
    runScripts: "dangerously",
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({
        postMessage: (message) => webviewMessages.push(message),
      });
    },
  });
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
    data: {
      type: "init",
      text: document.initialText,
      encodingLabel: "UTF-8",
      fileName: "font.csv",
      fontFamily: configuredFont,
    },
  }));
  assert.match(
    dom.window.document.documentElement.style.getPropertyValue("--csv-table-font-family"),
    /Microsoft JhengHei/
  );

  receiveMessage({ type: "ready" });
  assert.equal(postedMessages.at(-1).fontFamily, configuredFont);
  configuredFont = "My Installed Font, monospace";
  configurationListener({
    affectsConfiguration: (key) => key === "csvTableEditor.fontFamily",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(postedMessages.at(-1), {
    type: "fontFamily",
    fontFamily: "My Installed Font, monospace",
  });
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
    data: postedMessages.at(-1),
  }));
  assert.match(
    dom.window.document.documentElement.style.getPropertyValue("--csv-table-font-family"),
    /My Installed Font/
  );
  assert.equal(JSON.stringify(webviewMessages), JSON.stringify([{ type: "ready" }]));
  dom.window.close();
});

test("patched editable grid searches only a whole selected column", async () => {
  const vscode = {
    workspace: {
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
  };
  const webpackRequire = loadBundleInternals(vscode);
  const providerType = webpackRequire(248).CsvEditorProvider;
  const provider = Object.create(providerType.prototype);
  provider._context = { extensionUri: {} };
  provider._panels = new Map();
  provider._pendingGridRequests = new Map();
  const documentModel = {
    initialText: "Name,City\nAlice,Taipei\nAlice,Tokyo",
    encodingKey: "utf8",
    uri: { path: "/search.csv" },
    onDidChangeContent: () => ({ dispose() {} }),
  };
  const panel = {
    webview: {
      options: {},
      html: "",
      postMessage: async () => true,
      onDidReceiveMessage: () => ({ dispose() {} }),
    },
    onDidDispose: () => ({ dispose() {} }),
  };

  await provider.resolveCustomEditor(documentModel, panel, null);
  const dom = new JSDOM(panel.webview.html, {
    runScripts: "dangerously",
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({ postMessage() {} });
      window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
    },
  });
  const { window } = dom;
  const webviewDocument = window.document;
  window.dispatchEvent(new window.MessageEvent("message", {
    data: {
      type: "init",
      text: documentModel.initialText,
      encodingLabel: "UTF-8",
      fileName: "search.csv",
    },
  }));

  const search = webviewDocument.getElementById("filter");
  search.value = "Alice";
  search.dispatchEvent(new window.Event("input"));
  // Typing is debounced, so the scan lands after the pause rather than inline.
  await settleSearch();
  assert.equal(webviewDocument.querySelectorAll("tbody td.match").length, 2);
  assert.equal(webviewDocument.getElementById("filter-count").textContent, "1/2 results");

  const cityColumn = webviewDocument.querySelector('th[data-colhead="1"]');
  cityColumn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(webviewDocument.querySelectorAll("tbody td.match").length, 0);
  assert.equal(search.placeholder, "Find in column City");
  assert.equal(webviewDocument.getElementById("search-scope").textContent, "Column City only");

  cityColumn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(webviewDocument.querySelectorAll("tbody td.match").length, 2);
  assert.equal(search.placeholder, "Find in whole table");
  assert.equal(webviewDocument.getElementById("search-scope").textContent, "");

  const nameColumn = webviewDocument.querySelector('th[data-colhead="0"]');
  nameColumn.querySelector('[data-sortcol="0"]')
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(webviewDocument.querySelectorAll("tbody td.match").length, 2);
  assert.equal(search.placeholder, "Find in column Name");
  const ordinaryCell = webviewDocument.querySelector('td[data-r="2"][data-c="0"] .cell');
  ordinaryCell.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  assert.equal(webviewDocument.querySelectorAll("tbody td.match").length, 2);
  assert.equal(search.placeholder, "Find in whole table");

  webviewDocument.querySelector('th[data-rowhead="1"]')
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(search.placeholder, "Find in whole table", "row numbers never scope search");
  assert.equal(webviewDocument.getElementById("search-scope").textContent, "");

  dom.window.close();
});

test("patched distribution blocks oversized files before reading them", async () => {
  const calls = { readFile: 0, commands: [] };
  const vscode = {
    workspace: {
      fs: {
        stat: async () => ({ size: 600 * 1024 * 1024 }),
        readFile: async () => {
          calls.readFile++;
          throw new Error("oversized file should not be read");
        },
      },
      getConfiguration: () => ({ get: () => 64 }),
    },
    window: { showWarningMessage: async () => "Open as Text" },
    commands: {
      executeCommand: async (...args) => calls.commands.push(args),
    },
  };
  const webpackRequire = loadBundleInternals(vscode);
  const documentType = webpackRequire(745).CsvDocument;
  const uri = { scheme: "file", path: "/large.csv" };

  await assert.rejects(
    documentType.create(uri, {}, {}),
    (error) => error.code === "CSV_TABLE_EDITOR_FILE_TOO_LARGE"
  );
  assert.equal(calls.readFile, 0);
  assert.deepEqual(calls.commands, [["vscode.openWith", uri, "default"]]);
});

test("patched provider resolves oversized local files with the streaming webview", async () => {
  const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "csv-bundle-"));
  const filePath = path.join(temporaryDirectory, "large.csv");
  await fs.promises.writeFile(filePath, iconv.encode("姓名,城市\r\n王小明,臺北\r\n", "big5"));

  class EventEmitterStub {
    constructor() { this.event = () => {}; }
    dispose() {}
  }
  const vscode = {
    EventEmitter: EventEmitterStub,
    workspace: {
      fs: { stat: async () => ({ size: 1_839.9 * 1024 * 1024 }) },
      getConfiguration: () => ({ get: () => 64 }),
    },
  };
  const webpackRequire = loadBundleInternals(vscode);
  const providerType = webpackRequire(248).CsvEditorProvider;
  const provider = Object.create(providerType.prototype);
  const uri = {
    scheme: "file",
    fsPath: filePath,
    path: "/large.csv",
    toString: () => `file://${filePath}`,
  };

  try {
    const document = await provider.openCustomDocument(uri, {}, null);
    assert.equal(document.isLargeFile, true);
    assert.equal(document.encodingKey, "big5");

    const panel = {
      webview: {
        options: {},
        html: "",
        postMessage: async () => true,
        onDidReceiveMessage: () => ({ dispose() {} }),
      },
      onDidDispose: () => ({ dispose() {} }),
    };
    await provider.resolveCustomEditor(document, panel, null);
    assert.match(panel.webview.html, /Read-only preview/);
    document.dispose();
  } finally {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
