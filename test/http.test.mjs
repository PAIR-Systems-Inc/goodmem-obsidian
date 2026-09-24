import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadModule, selfSignedServer } from "./harness.mjs";

const { GoodMemHttpClient, HttpError } = loadModule("src/http.ts");

describe("request handling", () => {
  let server, exempt;
  before(async () => {
    server = await selfSignedServer("localhost", (req, res, body) => {
      const url = req.url ?? "";
      if (url.includes("/retry-then-ok")) {
        const n = (server.received.filter((r) => r.url?.includes("/retry-then-ok")) || []).length;
        if (n < 2) { res.writeHead(503); return res.end("busy"); }
        res.writeHead(201, { "content-type": "application/json" });
        return res.end(JSON.stringify({ memoryId: "m1" }));
      }
      if (url.includes("/no-content")) { res.writeHead(204); return res.end(); }
      if (url.includes("/bad-request")) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ errors: [{ field: "spaceId", message: "Invalid space ID format" }] }));
      }
      if (url.includes("/conflict")) { res.writeHead(409); return res.end("ALREADY_EXISTS"); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    exempt = `127.0.0.1:${server.port}`;
  });
  after(async () => { await server.close(); });

  const client = (max = 3) => new GoodMemHttpClient({
    apiKey: "k", timeoutMs: 5000, maxRetries: max, allowSelfSignedHost: exempt
  });

  test("201 Created is a success, not an error", async () => {
    const r = await client().requestJson("POST", `${server.origin}/retry-then-ok`, { a: 1 });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json, { memoryId: "m1" });
  });

  test("204 No Content returns no body rather than failing to parse one", async () => {
    const r = await client().requestJson("DELETE", `${server.origin}/no-content`);
    assert.equal(r.status, 204);
    assert.equal(r.json, undefined);
  });

  test("a 4xx carries the server's own message, not just a status", async () => {
    await assert.rejects(
      () => client(0).requestJson("POST", `${server.origin}/bad-request`, {}),
      (err) => err instanceof HttpError && err.status === 400 &&
               String(err.responseBodyText).includes("Invalid space ID format")
    );
  });

  test("a 409 is surfaced with its body so a caller can detect ALREADY_EXISTS", async () => {
    await assert.rejects(
      () => client(0).requestJson("POST", `${server.origin}/conflict`, {}),
      (err) => err.status === 409 && String(err.responseBodyText).includes("ALREADY_EXISTS")
    );
  });

  test("the API key travels as x-api-key on every request", async () => {
    await client().requestJson("GET", `${server.origin}/anything`);
    assert.equal(server.received.at(-1).headers["x-api-key"], "k");
  });
});
