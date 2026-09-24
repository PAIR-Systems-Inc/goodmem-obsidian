import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./harness.mjs";

const { normalizeGoodMemBaseUrl, memoriesCollectionUrl, memoryUrl, hostOf } =
  loadModule("src/goodmemEndpoints.ts");

describe("base URL handling", () => {
  test("adds /v1 once, and not twice", () => {
    assert.equal(normalizeGoodMemBaseUrl("https://x:8080"), "https://x:8080/v1");
    assert.equal(normalizeGoodMemBaseUrl("https://x:8080/"), "https://x:8080/v1");
    assert.equal(normalizeGoodMemBaseUrl("https://x:8080/v1"), "https://x:8080/v1");
    assert.equal(normalizeGoodMemBaseUrl("https://x:8080/v1/"), "https://x:8080/v1");
  });
  test("an empty server URL is refused rather than producing '/v1'", () => {
    assert.throws(() => normalizeGoodMemBaseUrl("  "), /empty/);
  });
});

describe("endpoint construction", () => {
  test("a memory id is URL-encoded into the path", () => {
    const base = normalizeGoodMemBaseUrl("https://x");
    assert.equal(memoriesCollectionUrl(base), "https://x/v1/memories");
    assert.equal(memoryUrl(base, "a/../b"), "https://x/v1/memories/a%2F..%2Fb");
  });
});

describe("hostOf", () => {
  test("returns host and port, so an exemption can be scoped to both", () => {
    assert.equal(hostOf("https://localhost:8080/v1"), "localhost:8080");
    assert.equal(hostOf("https://goodmem.internal"), "goodmem.internal");
  });
  test("an unparseable URL yields no host, so nothing can be exempt", () => {
    assert.equal(hostOf("not a url"), "");
    assert.equal(hostOf(""), "");
  });
});
