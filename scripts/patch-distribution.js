"use strict";

const fs = require("node:fs");
const path = require("node:path");

const bundlePath = path.join(__dirname, "..", "dist", "extension.js");
let bundle = fs.readFileSync(bundlePath, "utf8");

const previousGuard = 'static async create(e,t,n){const i="string"==typeof t.backupId?s.Uri.parse(t.backupId):e;await require("../src/large-file-guard").ensureFileCanOpen(i,s);const r=await d.readFile(i)';
const bypassableGuard = 'static async create(e,t,n){const i="string"==typeof t.backupId?s.Uri.parse(t.backupId):e;t.__csvTableEditorAllowLargeFile||await require("../src/large-file-guard").ensureFileCanOpen(i,s);const r=await d.readFile(i)';
if (bundle.includes(previousGuard)) bundle = bundle.replace(previousGuard, bypassableGuard);

const fixedFontMessageHandler = 'case"setFontFamily":{const e=require("../src/font-settings").normalizeFontFamily(t.fontFamily);require("../src/font-settings").setFontFamily(e,s),this._panels.forEach(t=>this.post(t,{type:"fontFamily",fontFamily:e}));break}';
if (bundle.includes(fixedFontMessageHandler)) {
  bundle = bundle.replace(fixedFontMessageHandler, "");
}

const baseWebview = "(0,l.getWebviewHtml)(t.webview,this._context.extensionUri)";
const fontOnlyWebview = `t.webview.html=require("../src/font-settings").decorateWebviewHtml(${baseWebview});`;
const scopedSearchWebview = `t.webview.html=require("../src/search-scope").decorateWebviewHtml(require("../src/font-settings").decorateWebviewHtml(${baseWebview}));`;
const gridPerformanceWebview = `t.webview.html=require("../src/grid-performance").decorateWebviewHtml(require("../src/search-scope").decorateWebviewHtml(require("../src/font-settings").decorateWebviewHtml(${baseWebview})));`;

// Upgrade a bundle patched by an earlier version to the current decorator chain.
if (bundle.includes(fontOnlyWebview)) {
  bundle = bundle.replace(fontOnlyWebview, gridPerformanceWebview);
} else if (bundle.includes(scopedSearchWebview)) {
  bundle = bundle.replace(scopedSearchWebview, gridPerformanceWebview);
}

const replacements = [
  {
    name: "private updater activation",
    from: 'e.activate=function(e){e.subscriptions.push(t.CsvEditorProvider.register(e))}',
    to: 'e.activate=function(e){e.subscriptions.push(t.CsvEditorProvider.register(e));try{require("../src/private-updater").activate(e,require("vscode"))}catch(e){console.error("CSV Table Editor: updater initialization failed")}}',
  },
  {
    name: "document-open detection call",
    from: 'o=(0,c.detectFromBom)(r)??"utf8",a=(0,c.decode)(r,o)',
    to: 'o=(0,c.detectEncoding)(r),a=(0,c.decode)(r,o)',
  },
  {
    name: "encoding detector export",
    from: 't.SUPPORTED_ENCODINGS=void 0,t.encodingKey=c,t.findEncoding=d,t.detectFromBom=function(e)',
    to: 't.SUPPORTED_ENCODINGS=void 0,t.encodingKey=c,t.findEncoding=d,t.detectEncoding=function(e){return require("../src/encoding-detector").detectEncoding(Buffer.from(e),s)},t.detectFromBom=function(e)',
    already: 't.detectEncoding=function(e){return require("../src/encoding-detector").detectEncoding(Buffer.from(e),s)}',
  },
  {
    name: "streaming decoder export",
    from: 't.detectEncoding=function(e){return require("../src/encoding-detector").detectEncoding(Buffer.from(e),s)},t.detectFromBom=function(e)',
    to: 't.detectEncoding=function(e){return require("../src/encoding-detector").detectEncoding(Buffer.from(e),s)},t.createDecoder=function(e){return s.getDecoder(d(e).id)},t.detectFromBom=function(e)',
  },
  {
    name: "UTF-16 encoding menu entries",
    from: '{id:"utf16le",label:"UTF-16 LE",bom:!0},{id:"utf16be",label:"UTF-16 BE",bom:!0}',
    to: '{id:"utf16le",label:"UTF-16 LE (no BOM)"},{id:"utf16le",label:"UTF-16 LE with BOM",bom:!0},{id:"utf16be",label:"UTF-16 BE (no BOM)"},{id:"utf16be",label:"UTF-16 BE with BOM",bom:!0}',
  },
  {
    name: "large file guard",
    from: 'static async create(e,t,n){const i="string"==typeof t.backupId?s.Uri.parse(t.backupId):e,r=await d.readFile(i)',
    to: bypassableGuard,
  },
  {
    name: "large file document factory",
    from: 'async openCustomDocument(e,t,n){const i={getGridData:()=>this.requestGridData(r)},r=await c.CsvDocument.create(e,t,i);return r}',
    to: 'async openCustomDocument(e,t,n){const o=await require("../src/large-file-mode").createLargeDocumentIfNeeded(e,t,s,d);if(o)return o;const i={getGridData:()=>this.requestGridData(r)},r=await c.CsvDocument.create(e,t,i);return r}',
  },
  {
    name: "large file editor resolver",
    from: 'async resolveCustomEditor(e,t,n){this._panels.set(e,t)',
      to: 'async resolveCustomEditor(e,t,n){if(e.isLargeFile)return require("../src/large-file-mode").resolveLargeFileEditor(e,t,s,d);this._panels.set(e,t)',
  },
  {
    name: "editable grid font, column-scoped search and performance support",
    from: 'this._panels.set(e,t),t.webview.options={enableScripts:!0},t.webview.html=(0,l.getWebviewHtml)(t.webview,this._context.extensionUri);',
    to: 'this._panels.set(e,t),t.webview.options={enableScripts:!0},' + gridPerformanceWebview,
  },
  {
    name: "editable grid initial font",
    from: 'this.post(t,{type:"init",text:e.initialText,encodingLabel:(0,d.findEncoding)(e.encodingKey).label,fileName:e.uri.path.split("/").pop()??"untitled.csv"});break}',
      to: 'this.post(t,{type:"init",text:e.initialText,encodingLabel:(0,d.findEncoding)(e.encodingKey).label,fileName:e.uri.path.split("/").pop()??"untitled.csv",fontFamily:require("../src/font-settings").getFontFamily(s)});break}',
  },
  {
    name: "editable grid live font updates",
    from: 'const i=t.webview.onDidReceiveMessage(t=>this.onMessage(e,t)),r=e.onDidChangeContent(e=>{this.post(t,{type:"setContent",text:e.text,encodingLabel:(0,d.findEncoding)(e.encodingKey).label})});t.onDidDispose(()=>{i.dispose(),r.dispose(),this._panels.delete(e)})',
    to: 'const i=t.webview.onDidReceiveMessage(t=>this.onMessage(e,t)),r=e.onDidChangeContent(e=>{this.post(t,{type:"setContent",text:e.text,encodingLabel:(0,d.findEncoding)(e.encodingKey).label})}),o=require("../src/font-settings").watchFontFamily(s,t.webview);t.onDidDispose(()=>{i.dispose(),r.dispose(),o.dispose(),this._panels.delete(e)})',
  },
  {
    name: "large file save bypass",
    from: 'async saveCustomDocument(e,t){await e.save(t),await this.captureHistory(e,e.uri)}',
    to: 'async saveCustomDocument(e,t){if(e.isLargeFile)return e.save(t);await e.save(t),await this.captureHistory(e,e.uri)}',
  },
  {
    name: "large file save-as bypass",
    from: 'async saveCustomDocumentAs(e,t,n){await e.saveAs(t,n),await this.captureHistory(e,t)}',
    to: 'async saveCustomDocumentAs(e,t,n){if(e.isLargeFile)return e.saveAs(t,n);await e.saveAs(t,n),await this.captureHistory(e,t)}',
  },
];

for (const replacement of replacements) {
  const currentCount = bundle.split(replacement.from).length - 1;
  const patchedCount = bundle.split(replacement.already || replacement.to).length - 1;
  if (currentCount === 1) {
    bundle = bundle.replace(replacement.from, replacement.to);
  } else if (currentCount === 0 && patchedCount === 1) {
    console.log(`${replacement.name}: already patched`);
  } else {
    throw new Error(`${replacement.name}: expected one source occurrence, found ${currentCount}`);
  }
}

fs.writeFileSync(bundlePath, bundle);
console.log(`Patched ${bundlePath}`);
