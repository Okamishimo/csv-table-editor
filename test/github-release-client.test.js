"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
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

test("private asset redirects strip authentication and retain binary content negotiation", async () => {
  const fake = server([
    { status: 302, headers: { location: "https://release-assets.githubusercontent.com/github-production-release-asset/file?signed=private" } },
    { body: "digest" },
  ]);
  const client = createClient(fake);
  assert.equal(await client.checksum({ id: 42, size: 6 }, "test-secret"), "digest");
  assert.equal(fake.calls[0].url, `https://api.github.com/repos/${REPOSITORY}/releases/assets/42`);
  assert.equal(fake.calls[0].options.headers.Authorization, "Bearer test-secret");
  assert.equal(fake.calls[1].options.headers.Authorization, undefined);
  assert.equal(fake.calls[1].options.headers.Accept, "application/octet-stream");
});

test("redirects cannot downgrade HTTPS, cross repository boundaries, or forward tokens to arbitrary hosts", () => {
  for (const url of ["http://api.github.com/", "https://evil.example/file", "https://api.github.com/repos/other/repo/file",
    `https://user:secret@api.github.com/repos/${REPOSITORY}/file`, "https://release-assets.githubusercontent.com:8443/file"]) {
    assert.throws(() => requestHeaders(url, "test-secret", "application/octet-stream"), /unsafe|unexpected/);
  }
  assert.equal(requestHeaders("https://objects.githubusercontent.com/file", "test-secret", "binary").Authorization, undefined);
});

test("client bounds response bodies and rejects incomplete assets and invalid JSON", async () => {
  for (const reply of [{ body: "x".repeat(257) }, { headers: { "content-length": "1000" } }, { body: "tiny" }]) {
    await assert.rejects(createClient(server([reply])).checksum({ id: 1, size: 100 }, "token"), /size limit|incomplete/);
  }
  await assert.rejects(createClient(server([{ body: "not json" }])).latest("token"), /invalid release metadata/);
});

test("network errors and HTTP responses never expose credentials or response bodies", async () => {
  for (const reply of [{ error: "secret-token signed-url" }, { status: 401, body: "secret-token" },
    { status: 404 }, { status: 500 }, { status: 302, headers: { location: "https://evil.example/secret-token" } }]) {
    await assert.rejects(createClient(server([reply])).latest("secret-token"), (error) => {
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
  try { await assert.rejects(createClient({ ...fake, timeoutMs: 20 }).latest("token"), /timed out/); }
  finally { clearTimeout(keepAlive); }
});
