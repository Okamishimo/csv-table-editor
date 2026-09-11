"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createClient, requestHeaders, httpError, REPOSITORY } = require("../src/github-release-client");

function server(replies) {
  const calls = [];
  function request(url, options, callback) {
    calls.push({ url, options });
    const request = new EventEmitter();
    request.end = () => {
      const reply = replies.shift();
      queueMicrotask(() => {
        if (reply.error) return request.emit("error", new Error(reply.error));
        const response = new PassThrough();
        response.statusCode = reply.status ?? 200;
        response.headers = reply.headers || {};
        callback(response);
        if (!reply.hang) response.end(reply.body || "");
      });
    };
    return request;
  }
  return { request, calls };
}

test("public metadata and streamed VSIX downloads never send authorization", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "csv-public-download-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const payload = Buffer.from([0x50, 0x4b, 0x00, 0xff, 0x80]);
  const fake = server([
    { body: JSON.stringify({ tag_name: "v1.0.0" }) },
    { status: 302, headers: { location: "https://objects.githubusercontent.com/release/file" } },
    { body: payload },
  ]);
  const client = createClient(fake);
  assert.deepEqual(await client.latest(), { tag_name: "v1.0.0" });
  const file = path.join(directory, "update.vsix");
  assert.equal(await client.download({ id: 7, size: payload.length }, file),
    createHash("sha256").update(payload).digest("hex"));
  assert.deepEqual(await fs.readFile(file), payload);
  assert.equal(fake.calls[0].url, `https://api.github.com/repos/${REPOSITORY}/releases/latest`);
  assert.equal(fake.calls[1].url, `https://api.github.com/repos/${REPOSITORY}/releases/assets/7`);
  assert.equal(fake.calls[0].options.headers.Accept, "application/vnd.github+json");
  assert.equal(fake.calls[0].options.headers["X-GitHub-Api-Version"], "2022-11-28");
  for (const call of fake.calls) assert.equal(Object.hasOwn(call.options.headers, "Authorization"), false);
  for (const call of fake.calls.slice(1)) assert.equal(call.options.headers.Accept, "application/octet-stream");
});

test("public asset redirects omit authentication and retain binary content negotiation", async () => {
  const fake = server([
    { status: 302, headers: { location: "https://release-assets.githubusercontent.com/github-production-release-asset/file?signed=private" } },
    { body: "digest" },
  ]);
  const client = createClient(fake);
  assert.equal(await client.checksum({ id: 42, size: 6 }), "digest");
  assert.equal(fake.calls[0].url, `https://api.github.com/repos/${REPOSITORY}/releases/assets/42`);
  assert.equal(fake.calls[0].options.headers.Authorization, undefined);
  assert.equal(fake.calls[1].options.headers.Authorization, undefined);
  assert.equal(fake.calls[1].options.headers.Accept, "application/octet-stream");
});

test("redirects cannot downgrade HTTPS, cross repository boundaries, or forward tokens to arbitrary hosts", () => {
  for (const url of ["http://api.github.com/", "https://evil.example/file", "https://api.github.com/repos/other/repo/file",
    `https://user:secret@api.github.com/repos/${REPOSITORY}/file`, "https://release-assets.githubusercontent.com:8443/file"]) {
    assert.throws(() => requestHeaders(url, "application/octet-stream"), /unsafe|unexpected/);
  }
  assert.equal(requestHeaders("https://objects.githubusercontent.com/file", "binary").Authorization, undefined);
});

test("client bounds response bodies and rejects incomplete assets and invalid JSON", async () => {
  for (const reply of [{ body: "x".repeat(257) }, { headers: { "content-length": "1000" } }, { body: "tiny" }]) {
    await assert.rejects(createClient(server([reply])).checksum({ id: 1, size: 100 }), /size limit|incomplete/);
  }
  await assert.rejects(createClient(server([{ body: "not json" }])).latest(), /invalid release metadata/);
});

test("network errors and HTTP responses never expose credentials or response bodies", async () => {
  for (const reply of [{ error: "secret-token signed-url" }, { status: 401, body: "secret-token" },
    { status: 404 }, { status: 500 }, { status: 302, headers: { location: "https://evil.example/secret-token" } }]) {
    await assert.rejects(createClient(server([reply])).latest(), (error) => {
      assert.doesNotMatch(error.message, /secret-token|signed-url/);
      return true;
    });
  }
});

test("rate limits create a bounded retry delay", () => {
  const now = 1800000000000;
  assert.equal(httpError(429, { "retry-after": "30" }, now).retryAt, now + 3600000);
  assert.equal(httpError(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 7200) }, now).retryAt, now + 7200000);
  assert.equal(httpError(429, { "retry-after": "999999999" }, now).retryAt, now + 86400000);
});

test("stalled response bodies are aborted within the operation deadline", async () => {
  const fake = server([{ hang: true }]);
  // A referenced timer keeps this isolated fake network operation alive in node:test.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(createClient({ ...fake, timeoutMs: 20 }).latest(), /timed out/); }
  finally { clearTimeout(keepAlive); }
});
