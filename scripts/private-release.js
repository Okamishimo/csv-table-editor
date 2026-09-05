"use strict";

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { stableVersion, verifyVsixManifest } = require("../src/update-artifact");
const { REPOSITORY } = require("../src/github-release-client");

function releaseInfo(manifest, tag) {
  if (!stableVersion(manifest.version) || tag !== `v${manifest.version}`) {
    throw new Error("Release tag must be vX.Y.Z and match the stable package.json version exactly.");
  }
  return { version: manifest.version, tag, name: `csv-table-editor-${manifest.version}-enhanced.vsix` };
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function existingRelease(tag, runGh = gh) {
  // REST /releases/tags only finds published releases. Resolve the ID through
  // GraphQL first so pending tags on drafts are found too (as gh release does).
  const [owner, name] = REPOSITORY.split("/");
  const query = "query($owner:String!,$name:String!,$tag:String!){repository(owner:$owner,name:$name){release(tagName:$tag){databaseId}}}";
  try {
    const response = JSON.parse(runGh(["api", "graphql", "-f", `query=${query}`,
      "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `tag=${tag}`]));
    const repository = response.data?.repository;
    if (response.errors?.length || !repository) throw new Error("Repository lookup failed.");
    if (repository.release === null) return null;
    const id = repository.release?.databaseId;
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid release ID.");
    const release = JSON.parse(runGh(["api", `repos/${REPOSITORY}/releases/${id}`]));
    if (release.tag_name !== tag || typeof release.draft !== "boolean" || !Array.isArray(release.assets)) {
      throw new Error("Invalid release response.");
    }
    return release;
  } catch {
    throw new Error("Cannot read the GitHub Release. Check Actions contents permission and connectivity.");
  }
}

function ensureAssetsAvailable(release, name) {
  if (release?.assets?.some((asset) => asset.name === name || asset.name === `${name}.sha256`)) {
    throw new Error("This version already has release assets. Never overwrite them; increment the version for a changed build.");
  }
}

async function main(command = process.argv[2], runGh = gh) {
  const manifest = require("../package.json");
  const info = releaseInfo(manifest, process.env.RELEASE_TAG);
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== REPOSITORY) throw new Error("Unexpected release repository.");
  if (command === "prepare") {
    const release = existingRelease(info.tag, runGh);
    const assets = release?.assets || [];
    const complete = [info.name, `${info.name}.sha256`].every((name) =>
      assets.some((asset) => asset.name === name && asset.state === "uploaded" && asset.size > 0));
    if (complete) {
      // Tag + release events can both fire. Reuse an already published release.
      if (release.draft) runGh(["release", "edit", info.tag, "--repo", REPOSITORY, "--draft=false"]);
      console.log("This tag already has both assets; skipping duplicate packaging.");
      fs.appendFileSync(process.env.GITHUB_OUTPUT, "skip=true\n");
      return;
    }
    ensureAssetsAvailable(release, info.name);
    if (fs.existsSync(info.name)) throw new Error("The target VSIX already exists. Increment the version instead of replacing it.");
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `skip=false\nvsix=${info.name}\n`);
  } else if (command === "verify") {
    await verifyVsixManifest(info.name, manifest, info.version);
    const { open } = require("yauzl"); // Development dependency provided by vsce.
    const entries = await new Promise((resolve, reject) => open(info.name, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const names = [];
      zip.on("entry", (entry) => { names.push(entry.fileName); zip.readEntry(); });
      zip.on("error", reject);
      zip.on("end", () => resolve(names));
      zip.readEntry();
    }));
    const required = ["package.json", "dist/extension.js", "readme.md", "changelog.md", "LICENSE.txt",
      ...fs.readdirSync("src").filter((name) => name.endsWith(".js")).map((name) => `src/${name}`),
      ...fs.readdirSync("media").map((name) => `media/${name}`)];
    for (const name of required) if (!entries.includes(`extension/${name}`)) throw new Error(`Package is missing ${name}`);
    if (entries.some((name) => /^extension\/(?:node_modules|test|scripts|\.github)\//.test(name))) throw new Error("Package contains development-only files.");
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(info.name)) hash.update(chunk);
    const digest = hash.digest("hex");
    fs.writeFileSync(`${info.name}.sha256`, `${digest}  ${info.name}\n`, { flag: "wx" });
    console.log(`${info.name}: ${fs.statSync(info.name).size} bytes; SHA-256 ${digest}`);
  } else if (command === "publish") {
    let release = existingRelease(info.tag, runGh);
    ensureAssetsAvailable(release, info.name);
    if (!release) {
      runGh(["release", "create", info.tag, "--repo", REPOSITORY, "--verify-tag", "--draft", "--title", info.tag, "--generate-notes"]);
      release = existingRelease(info.tag, runGh);
      if (!release) throw new Error("The created draft release is not visible yet. Retry the workflow after GitHub finishes creating it.");
    }
    // No --clobber: published assets are never replaced, including partial uploads.
    runGh(["release", "upload", info.tag, info.name, `${info.name}.sha256`, "--repo", REPOSITORY]);
    if (release.draft) runGh(["release", "edit", info.tag, "--repo", REPOSITORY, "--draft=false"]);
    console.log(`Uploaded verified assets to ${REPOSITORY} release ${info.tag}.`);
  } else throw new Error("Expected prepare, verify, or publish.");
}

if (require.main === module) main().catch((error) => {
  // gh errors can contain request details; report only our own validation messages.
  console.error(error.status !== undefined ? "GitHub release command failed; no existing assets were overwritten." : error.message);
  process.exitCode = 1;
});

module.exports = { releaseInfo, ensureAssetsAvailable, existingRelease, main };
