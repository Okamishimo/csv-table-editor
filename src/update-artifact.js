"use strict";

const fs = require("node:fs/promises");
const { inflateRawSync } = require("node:zlib");

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_VSIX_BYTES = 128 * 1024 * 1024;

class UpdateError extends Error {
  constructor(message, retryAt = 0) {
    super(message);
    this.name = "UpdateError";
    this.retryAt = retryAt;
  }
}

function stableVersion(value) {
  return typeof value === "string" && value.length <= 64 && STABLE_VERSION.test(value);
}

function isNewer(candidate, installed) {
  if (!stableVersion(candidate)) return false;
  const match = /^(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(installed);
  if (!match || !stableVersion(match[1])) throw new UpdateError("The installed extension version is invalid.");
  const left = candidate.split(".").map(BigInt);
  const right = match[1].split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return Boolean(match[2]);
}

function selectRelease(release, current) {
  if (!release || release.draft || release.prerelease) return null;
  const version = typeof release.tag_name === "string" ? release.tag_name.replace(/^v/, "") : "";
  if (!stableVersion(version)) throw new UpdateError("The latest release must have a stable vX.Y.Z tag.");
  if (!isNewer(version, current)) return null;
  const name = `csv-table-editor-${version}-enhanced.vsix`;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  function assetNamed(expected, limit) {
    const matches = assets.filter((asset) => asset.name === expected);
    const asset = matches[0];
    if (matches.length !== 1 || asset.state !== "uploaded" || !Number.isSafeInteger(asset.id) || asset.id <= 0 ||
        !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > limit) {
      throw new UpdateError("The release is missing a valid VSIX or SHA-256 asset. Wait for the release workflow to finish.");
    }
    return asset;
  }
  return { version, name, vsix: assetNamed(name, MAX_VSIX_BYTES), checksum: assetNamed(`${name}.sha256`, 256) };
}

function parseChecksum(text, name) {
  const match = /^([a-fA-F0-9]{64}) [ *]([^\r\n]+)\r?\n?$/.exec(text);
  if (!match || match[2] !== name) throw new UpdateError("The release SHA-256 file is invalid.");
  return match[1].toLowerCase();
}

// Read only the ZIP directory and the small manifest, never extract the archive.
// VSIX files produced by this project fit classic ZIP limits; ZIP64 is rejected.
async function verifyVsixManifest(filePath, expected, version) {
  const file = await fs.open(filePath, "r");
  try {
    const { size } = await file.stat();
    if (size < 22 || size > MAX_VSIX_BYTES) throw new Error("size");
    async function read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > size) throw new Error("bounds");
      const bytes = Buffer.alloc(length);
      const result = await file.read(bytes, 0, length, offset);
      if (result.bytesRead !== length) throw new Error("truncated");
      return bytes;
    }
    const tail = await read(Math.max(0, size - 65557), Math.min(size, 65557));
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
        end = i;
        break;
      }
    }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error("directory");
    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (count === 65535 || count !== tail.readUInt16LE(end + 8) || directorySize > 1024 * 1024 ||
        directoryOffset + directorySize !== size - tail.length + end) throw new Error("directory bounds");
    const directory = await read(directoryOffset, directorySize);
    let offset = 0;
    let manifest;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) throw new Error("entry");
      const nameSize = directory.readUInt16LE(offset + 28);
      const next = offset + 46 + nameSize + directory.readUInt16LE(offset + 30) + directory.readUInt16LE(offset + 32);
      if (next > directory.length) throw new Error("entry bounds");
      const name = directory.toString("utf8", offset + 46, offset + 46 + nameSize);
      if (name.toLowerCase() === "extension/package.json") {
        if (manifest || name !== "extension/package.json" || (directory.readUInt16LE(offset + 8) & 1)) throw new Error("manifest");
        const method = directory.readUInt16LE(offset + 10);
        const compressedSize = directory.readUInt32LE(offset + 20);
        const expandedSize = directory.readUInt32LE(offset + 24);
        const localOffset = directory.readUInt32LE(offset + 42);
        if (compressedSize > 65536 || expandedSize > 65536) throw new Error("manifest size");
        const local = await read(localOffset, 30);
        if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(8) !== method || (local.readUInt16LE(6) & 1)) throw new Error("header");
        const localName = await read(localOffset + 30, local.readUInt16LE(26));
        if (localName.toString("utf8") !== name) throw new Error("name");
        const dataOffset = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        if (dataOffset + compressedSize > directoryOffset) throw new Error("data bounds");
        const data = await read(dataOffset, compressedSize);
        const json = method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: 65536 }) : null;
        if (!json || json.length !== expandedSize) throw new Error("compression");
        manifest = JSON.parse(json.toString("utf8"));
      }
      offset = next;
    }
    if (offset !== directory.length || !manifest || manifest.publisher !== expected.publisher ||
        manifest.name !== expected.name || manifest.version !== version) throw new Error("identity");
  } catch {
    throw new UpdateError("The downloaded VSIX has an invalid manifest, extension identity, or version.");
  } finally {
    await file.close();
  }
}

module.exports = { UpdateError, MAX_VSIX_BYTES, stableVersion, isNewer, selectRelease, parseChecksum, verifyVsixManifest };
