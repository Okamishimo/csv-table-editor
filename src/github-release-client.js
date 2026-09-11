"use strict";

const https = require("node:https");
const fs = require("node:fs");
const { Transform, Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createHash } = require("node:crypto");
const { UpdateError, MAX_VSIX_BYTES } = require("./update-artifact");

const REPOSITORY = "Okamishimo/csv-table-editor";
const API_ROOT = `https://api.github.com/repos/${REPOSITORY}`;

function requestHeaders(url, accept) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port && parsed.port !== "443") {
    throw new UpdateError("GitHub returned an unsafe download URL.");
  }
  const isApi = parsed.hostname === "api.github.com" && parsed.pathname.startsWith(`/repos/${REPOSITORY}/`);
  if (!isApi && !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(parsed.hostname)) {
    throw new UpdateError("GitHub returned an unexpected download host.");
  }
  const headers = { "User-Agent": "csv-table-editor-updater", Accept: accept };
  if (isApi) {
    headers["X-GitHub-Api-Version"] = "2022-11-28";
  }
  return headers;
}

function httpError(status, headers, now = Date.now()) {
  if (status === 429 || status === 403 && (headers["x-ratelimit-remaining"] === "0" || headers["retry-after"])) {
    const retry = Number(headers["retry-after"]);
    const reset = Number(headers["x-ratelimit-reset"]) * 1000;
    const retryAt = Math.min(now + 24 * 3600000, Math.max(now + 3600000,
      Number.isFinite(retry) ? now + retry * 1000 : 0, Number.isFinite(reset) ? reset : 0));
    return new UpdateError("GitHub API rate limit reached. The updater will retry later.", retryAt);
  }
  if ([401, 403, 404].includes(status)) return new UpdateError(`GitHub HTTP ${status}: check that the repository and stable release are public and the release assets are available.`);
  return new UpdateError(`GitHub request failed (HTTP ${status}).`);
}

function createClient({ request = https.request, timeoutMs = 120000 } = {}) {
  async function transfer(url, { limit, accept, filePath, expectedSize }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    let size = 0;
    const chunks = [];
    const hash = createHash("sha256");
    try {
      let response;
      for (let redirects = 0; redirects <= 3; redirects++) {
        const headers = requestHeaders(url, accept);
        response = await new Promise((resolve, reject) => {
          const req = request(url, { headers, signal: controller.signal }, resolve);
          req.on("error", reject);
          req.end();
        });
        // Discard redirect bodies without buffering; every target is validated.
        response.on("error", () => {});
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const location = response.headers.location;
          response.destroy();
          if (!location || redirects === 3) throw new UpdateError("GitHub download redirected too many times.");
          url = new URL(location, url).href;
          continue;
        }
        break;
      }
      if (response.statusCode !== 200) {
        response.destroy();
        throw httpError(response.statusCode, response.headers);
      }
      if (Number(response.headers["content-length"]) > limit) {
        response.destroy();
        throw new UpdateError("GitHub response exceeds the update size limit.");
      }
      const meter = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          if (size > limit) return callback(new UpdateError("GitHub response exceeds the update size limit."));
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      const destination = filePath ? fs.createWriteStream(filePath, { flags: "wx", mode: 0o600 }) :
        new Writable({ write(chunk, encoding, callback) { chunks.push(chunk); callback(); } });
      await pipeline(response, meter, destination, { signal: controller.signal });
      if (expectedSize !== undefined && size !== expectedSize) throw new UpdateError("The release asset download was incomplete.");
      return { text: filePath ? undefined : Buffer.concat(chunks).toString("utf8"), sha256: hash.digest("hex") };
    } catch (error) {
      if (error instanceof UpdateError) throw error;
      // Never surface request errors containing headers, tokens, or signed URLs.
      throw new UpdateError(controller.signal.aborted ? "GitHub download timed out." : "GitHub network or download write failed. Check your connection and disk space.");
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    async latest() {
      const result = await transfer(`${API_ROOT}/releases/latest`, { limit: 1024 * 1024, accept: "application/vnd.github+json" });
      try { return JSON.parse(result.text); } catch { throw new UpdateError("GitHub returned invalid release metadata."); }
    },
    async checksum(asset) {
      return (await transfer(`${API_ROOT}/releases/assets/${asset.id}`,
        { limit: 256, expectedSize: asset.size, accept: "application/octet-stream" })).text;
    },
    async download(asset, filePath) {
      return (await transfer(`${API_ROOT}/releases/assets/${asset.id}`,
        { limit: MAX_VSIX_BYTES, expectedSize: asset.size, accept: "application/octet-stream", filePath })).sha256;
    },
  };
}

module.exports = { REPOSITORY, createClient, requestHeaders, httpError };
