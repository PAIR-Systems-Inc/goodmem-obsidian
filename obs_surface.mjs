// Every layer of the plugin that can run outside Obsidian, against the live server.
import { loadModule, selfSignedServer } from "./test/harness.mjs";
import { execFileSync } from "node:child_process";

const KEY = execFileSync("python3", ["-c",
  "import tomllib,pathlib;print(tomllib.loads((pathlib.Path.home()/'.goodmem/config.toml').read_text())['profiles']['goodmem-1']['api_key'])"
]).toString().trim();
const BASE = "https://localhost:8080", HOST = "localhost:8080";
const EMB = "019cfd1c-c033-7517-b7de-f73941a0464b";

const { GoodMemApiClient } = loadModule("src/goodmemApiClient.ts");
const { GoodMemHttpClient } = loadModule("src/http.ts");
const { normalizeGoodMemBaseUrl, memoryUrl, hostOf } = loadModule("src/goodmemEndpoints.ts");
const { extractAllTags } = loadModule("src/tags.ts");

let n = 0;
const step = (t) => console.log(`\n${"─".repeat(74)}\n${String(++n).padStart(2)}. ${t}\n${"─".repeat(74)}`);
const ok = (l, v) => console.log(`    ${String(l).padEnd(32)} ${v}`);
const sh = (a) => execFileSync("curl", a).toString();
const H = ["-sk", "-H", `x-api-key: ${KEY}`, "-H", "Content-Type: application/json"];

const space = JSON.parse(sh([...H, "-X", "POST", `${BASE}/v1/spaces`, "-d", JSON.stringify({
  name: `obsidian-surface-${Date.now()}`,
  spaceEmbedders: [{ embedderId: EMB, defaultRetrievalWeight: 1.0 }],
  defaultChunkingConfig: { recursive: { chunkSize: 256, chunkOverlap: 25,
    separators: ["\n\n","\n",". "," ",""], keepStrategy: "KEEP_END",
    separatorIsRegex: false, lengthMeasurement: "CHARACTER_COUNT" } }
})]));
console.log(`setup: space ${space.spaceId}`);

const api = (host) => new GoodMemApiClient({ serverUrl: BASE, apiKey: KEY, timeoutMs: 15000, maxRetries: 1, allowSelfSignedHost: host });
const MID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const NOTE = (rev) => ({ memoryId: MID, spaceId: space.spaceId,
  originalContent: `# Meeting notes\n\nrevision ${rev} — canary OBSIDIAN-91-QUARTZ.\n\n#work #q3/planning`,
  contentType: "text/markdown",
  metadata: { source: "obsidian", vault: "demo", source_path: "notes/meeting.md",
              title: "meeting", tags: ["work","q3/planning"], path_labels: ["notes"] } });

step("TLS verified by default — a self-signed server is refused");
try { await api(undefined).createMemory(NOTE(1)); ok("result", "CONNECTED (would be a bug)"); }
catch (e) { ok("refused", String(e.message).slice(0, 56)); ok("0.1.0 here", "uploaded the note and the API key"); }

step("the per-host exemption lets the configured server through");
const client = api(HOST);
const created = await client.createMemory(NOTE(1));
ok("createMemory ->", created.memoryId);
ok("client-supplied id honoured", created.memoryId === MID);
ok("content on server", sh([...H, `${BASE}/v1/memories/${MID}/content`]).slice(0, 34) + "…");

step("an exemption for a DIFFERENT host does not cover this one");
try { await api("goodmem.internal:8443").createMemory(NOTE(9)); ok("result", "CONNECTED (bug)"); }
catch (e) { ok("refused", String(e.message).slice(0, 56)); }

step("re-saving a note: delete-then-create (GoodMem has no update endpoint)");
for (const m of ["PUT", "PATCH"]) {
  const code = sh([...H, "-o", "/dev/null", "-w", "%{http_code}", "-X", m, `${BASE}/v1/memories/${MID}`, "-d", '{"originalContent":"x"}']);
  ok(`${m} /v1/memories/{id}`, `${code} (no update path)`);
}
const dup = sh([...H, "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", `${BASE}/v1/memories`, "-d", JSON.stringify(NOTE(2))]);
ok("re-create without delete", `${dup} (ALREADY_EXISTS)`);
await client.deleteMemory(MID);
await client.createMemory(NOTE(2));
ok("after delete+create", sh([...H, `${BASE}/v1/memories/${MID}/content`]).split("\n")[2] ?? "(updated)");

step("deleting an already-deleted memory is not an error");
await client.deleteMemory(MID);
await client.deleteMemory(MID);
ok("second delete", "no throw — 404 treated as success");

step("the server's own error message survives (0.1.0 returned a generic one)");
try { await api(HOST).createMemory({ ...NOTE(3), spaceId: "not-a-uuid" }); ok("result", "no error (bug)"); }
catch (e) { ok("status", e.status); ok("server said", String(e.responseBodyText).slice(0, 62)); }

step("metadata and tags as the plugin writes them");
const md = "# Note\n\n#work #q3/planning and `#notacode` plus\n```\n#fenced\n```\n";
ok("extractAllTags", JSON.stringify(extractAllTags(md)));
await client.createMemory(NOTE(4));
const got = JSON.parse(sh([...H, `${BASE}/v1/memories/${MID}`]));
ok("metadata round-trip", JSON.stringify(got.metadata));
ok("contentType", got.contentType);

step("endpoint construction");
ok("normalize (no /v1)", normalizeGoodMemBaseUrl("https://h:8080"));
ok("normalize (with /v1)", normalizeGoodMemBaseUrl("https://h:8080/v1/"));
ok("memoryUrl encodes id", memoryUrl("https://h/v1", "a/../b"));
ok("hostOf", `${hostOf(BASE)} | unparseable -> "${hostOf("not a url")}"`);

step("retries: a 503 is retried, a 400 is not");
const srv = await selfSignedServer("localhost", (req, res) => {
  const hits = srv.received.filter((r) => r.url === req.url).length;
  if (req.url.includes("/flaky")) {
    if (hits < 2) { res.writeHead(503); return res.end("busy"); }
    res.writeHead(201, { "content-type": "application/json" }); return res.end('{"memoryId":"ok"}');
  }
  res.writeHead(400, { "content-type": "application/json" }); res.end('{"errors":[{"message":"nope"}]}');
});
const hc = new GoodMemHttpClient({ apiKey: "k", timeoutMs: 5000, maxRetries: 3, allowSelfSignedHost: `127.0.0.1:${srv.port}` });
const flaky = await hc.requestJson("POST", `${srv.origin}/flaky`, {});
ok("503 then 201", `${flaky.status} after ${srv.received.filter(r=>r.url.includes("/flaky")).length} attempts`);
const before = srv.received.length;
try { await hc.requestJson("POST", `${srv.origin}/bad`, {}); } catch (e) { ok("400", `${e.status}, ${srv.received.length - before} attempt (not retried)`); }
await srv.close();

sh([...H, "-X", "DELETE", `${BASE}/v1/spaces/${space.spaceId}`]);
const left = JSON.parse(sh([...H, `${BASE}/v1/spaces`])).spaces.filter(s => s.name.includes("obsidian-surface"));
console.log(`\n    teardown: deleted the space | leftover: ${left.length ? left.map(s=>s.name) : "none — clean"}`);
