"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { existingRelease, main } = require("../scripts/private-release");
const manifest = require("../package.json");

const tag = `v${manifest.version}`;
const name = `csv-table-editor-${manifest.version}-enhanced.vsix`;
const release = { id: 123, tag_name: tag, draft: true, assets: [] };
const found = { data: { repository: { release: { databaseId: 123 } } } };
const absent = { data: { repository: { release: null } } };

function setTag(t) {
  const previous = process.env.RELEASE_TAG;
  process.env.RELEASE_TAG = tag;
  t.after(() => {
    if (previous === undefined) delete process.env.RELEASE_TAG;
    else process.env.RELEASE_TAG = previous;
  });
}

test("release lookup resolves draft and published tags through GraphQL and fetches REST metadata by ID", () => {
  for (const draft of [true, false]) {
    const calls = [];
    const result = existingRelease(tag, (args) => {
      calls.push(args);
      return JSON.stringify(args[1] === "graphql" ? found : { ...release, draft });
    });
    assert.equal(result.draft, draft);
    assert.ok(calls[0].includes(`tag=${tag}`));
    assert.deepEqual(calls[1], ["api", "repos/Okamishimo/csv-table-editor/releases/123"]);
    assert.equal(calls.length, 2);
  }
});

test("only an explicit absent release is treated as missing; access and malformed responses fail closed", () => {
  assert.equal(existingRelease(tag, () => JSON.stringify(absent)), null);
  for (const response of [{ data: { repository: null } }, { errors: [{ message: "private details" }] },
    { data: { repository: {} } }, { data: { repository: { release: { databaseId: "123" } } } }]) {
    assert.throws(() => existingRelease(tag, () => JSON.stringify(response)), /Cannot read the GitHub Release/);
  }
  assert.throws(() => existingRelease(tag, () => { throw new Error("request with secret-token"); }), (error) => {
    assert.doesNotMatch(error.message, /secret-token/);
    return true;
  });
  assert.throws(() => existingRelease(tag, (args) => JSON.stringify(args[1] === "graphql" ? found : { ...release, tag_name: "wrong-tag" })), /Cannot read/);
});

test("first publication creates a draft, finds it, uploads once and publishes it", async (t) => {
  setTag(t);
  let created = false;
  const mutations = [];
  await main("publish", (args) => {
    if (args[0] === "api") return JSON.stringify(args[1] === "graphql" ? (created ? found : absent) : release);
    mutations.push(args);
    if (args[1] === "create") created = true;
    return "";
  });
  assert.deepEqual(mutations.map((args) => args[1]), ["create", "upload", "edit"]);
  assert.ok(mutations[0].includes("--draft"));
  assert.ok(mutations[1].includes(name));
  assert.ok(mutations[1].includes(`${name}.sha256`));
  assert.ok(!mutations[1].includes("--clobber"));
  assert.ok(mutations[2].includes("--draft=false"));
});

test("rerunning after both assets uploaded publishes the same draft and skips packaging", async (t) => {
  setTag(t);
  const ready = { ...release, assets: [name, `${name}.sha256`].map((name) => ({ name, state: "uploaded", size: 100 })) };
  const mutations = [];
  const outputs = [];
  t.mock.method(fs, "appendFileSync", (file, value) => outputs.push(value));
  await main("prepare", (args) => {
    if (args[0] === "api") return JSON.stringify(args[1] === "graphql" ? found : ready);
    mutations.push(args);
    return "";
  });
  assert.deepEqual(mutations, [["release", "edit", tag, "--repo", "Okamishimo/csv-table-editor", "--draft=false"]]);
  assert.deepEqual(outputs, ["skip=true\n"]);
});

test("partial uploads cannot be repackaged or overwritten, even on a draft", async (t) => {
  setTag(t);
  for (const command of ["prepare", "publish"]) {
    await assert.rejects(main(command, (args) => {
      assert.equal(args[0], "api", "existing assets must prevent all mutations");
      return JSON.stringify(args[1] === "graphql" ? found : { ...release, assets: [{ name }] });
    }), /Never overwrite/);
  }
});

test("a newly created draft that is not visible yet fails before uploading with a retryable explanation", async (t) => {
  setTag(t);
  const mutations = [];
  await assert.rejects(main("publish", (args) => {
    if (args[0] === "api") return JSON.stringify(absent);
    mutations.push(args[1]);
    return "";
  }), /created draft release is not visible yet/);
  assert.deepEqual(mutations, ["create"]);
});
