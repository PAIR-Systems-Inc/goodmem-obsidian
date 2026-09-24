import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadModule, selfSignedServer } from "./harness.mjs";

const { GoodMemHttpClient, isExemptHost } = loadModule("src/http.ts");

const NOTE = { spaceId: "s", originalContent: "# Private note\n\nsalary: secret", contentType: "text/markdown" };
const KEY = "gm_the_users_real_api_key";

function client(extra = {}) {
  return new GoodMemHttpClient({ apiKey: KEY, timeoutMs: 5000, maxRetries: 0, ...extra });
}

describe("TLS verification", () => {
  let server;
  before(async () => { server = await selfSignedServer("totally-different-host.example.com"); });
  after(async () => { await server.close(); });

  test("refuses a certificate issued to another host", async () => {
    // 0.1.0 set rejectUnauthorized:false for every host, so this succeeded and
    // handed the note body and the API key to whoever answered.
    await assert.rejects(
      () => client().requestJson("POST", `${server.origin}/v1/memories`, NOTE),
      (err) => /self.signed|certificate|altname|CERT/i.test(String(err.message)),
      "a wrong-host certificate must not be accepted"
    );
    assert.equal(server.received.length, 0, "nothing may reach a server we could not verify");
  });

  test("an exemption for one host does not apply to another", async () => {
    const c = client({ allowSelfSignedHost: "goodmem.internal:8443" });
    await assert.rejects(() => c.requestJson("POST", `${server.origin}/v1/memories`, NOTE));
    assert.equal(server.received.length, 0);
  });

  test("an exemption for exactly this host is honoured", async () => {
    const c = client({ allowSelfSignedHost: `127.0.0.1:${server.port}` });
    const r = await c.requestJson("POST", `${server.origin}/v1/memories`, NOTE);
    assert.equal(r.status, 200);
    assert.equal(server.received.at(-1).headers["x-api-key"], KEY);
  });
});

describe("isExemptHost", () => {
  test("no exemption configured means verify everywhere", () => {
    assert.equal(isExemptHost("localhost:8080", undefined), false);
    assert.equal(isExemptHost("localhost:8080", ""), false);
  });
  test("matches case-insensitively and ignores the default https port", () => {
    assert.equal(isExemptHost("GoodMem.Internal", "goodmem.internal"), true);
    assert.equal(isExemptHost("goodmem.internal:443", "goodmem.internal"), true);
  });
  test("a different host or port is not exempt", () => {
    assert.equal(isExemptHost("evil.example.com", "goodmem.internal"), false);
    assert.equal(isExemptHost("goodmem.internal:9999", "goodmem.internal:8443"), false);
  });
});
