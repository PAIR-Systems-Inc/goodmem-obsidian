// Bundles the plugin's real TypeScript with esbuild and loads it under Node,
// so the tests exercise the shipped code rather than a re-implementation.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import https from "node:https";
import { X509Certificate } from "node:crypto";

const require = createRequire(import.meta.url);

/**
 * A stand-in for Obsidian's runtime module.
 *
 * `tags.ts` imports `parseYaml` from "obsidian", which only exists inside the
 * app. Obsidian's own implementation is js-yaml; a minimal reader covers the
 * frontmatter shapes the plugin parses (a scalar, an inline list, a block
 * list) and keeps the tests dependency-free.
 */
function obsidianStub() {
  const parseYaml = (text) => {
    const doc = {};
    const lines = String(text ?? "").split("\n");
    let key = null;
    for (const raw of lines) {
      if (!raw.trim() || raw.trim().startsWith("#")) continue;
      const item = raw.match(/^\s*-\s*(.+?)\s*$/);
      if (item && key) {
        (doc[key] = Array.isArray(doc[key]) ? doc[key] : []).push(strip(item[1]));
        continue;
      }
      const kv = raw.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (!kv) continue;
      key = kv[1];
      const value = kv[2].trim();
      if (!value) { doc[key] = []; continue; }
      doc[key] = value.startsWith("[")
        ? value.slice(1, -1).split(",").map((v) => strip(v)).filter(Boolean)
        : strip(value);
    }
    return doc;
  };
  const strip = (v) => v.trim().replace(/^["']|["']$/g, "");
  // Enough of TFile for SyncManager's `instanceof TFile` check and `.extension`.
  class TFile {
    constructor(path) {
      this.path = path;
      this.extension = path.includes(".") ? path.split(".").pop() : "";
    }
  }
  // Notices are UI; outside Obsidian they are recorded, not shown.
  class Notice {
    constructor(message) {
      this.message = message;
      Notice.shown.push(message);
    }
  }
  Notice.shown = [];
  // Enough of Plugin for main.ts's onload(); data.json is the `data` field.
  class Plugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
      this.data = null;
    }
    async loadData() { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)); }
    async saveData(d) { this.data = JSON.parse(JSON.stringify(d)); }
    addStatusBarItem() { return { setText() {}, remove() {} }; }
    addSettingTab() {}
    addCommand() {}
    registerEvent() {}
  }
  class PluginSettingTab {}
  class Setting {}
  return { parseYaml, TFile, Notice, Plugin, PluginSettingTab, Setting };
}

/**
 * The one stub instance every bundle sees. Tests construct TFile through it so
 * SyncManager's `instanceof TFile` holds, and read Notice.shown from it.
 */
export const obsidian = obsidianStub();

/** Bundle a source module to CJS and require it. */
export function loadModule(entry) {
  const dir = mkdtempSync(join(tmpdir(), "gm-obsidian-"));
  const out = join(dir, "bundle.cjs");
  execFileSync("npx", ["esbuild", entry, "--bundle", "--platform=node",
    "--format=cjs", "--external:http", "--external:https", "--external:obsidian",
    `--outfile=${out}`], { stdio: "pipe" });
  // The plugin targets Obsidian's renderer, where `window` exists.
  globalThis.window ??= { setTimeout, clearTimeout };
  // "obsidian" is external in the bundle and unresolvable outside the app.
  const obsidianPath = require.resolve("node:util");
  require.cache[obsidianPath] = { id: obsidianPath, filename: obsidianPath,
    loaded: true, exports: obsidian };
  const Module = require("node:module");
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "obsidian") return obsidianPath;
    return origResolve.call(this, request, ...rest);
  };
  try {
    return require(out);
  } finally {
    Module._resolveFilename = origResolve;
  }
}

/** A self-signed HTTPS server whose certificate names `cn`. */
export async function selfSignedServer(cn, handler) {
  const dir = mkdtempSync(join(tmpdir(), "gm-cert-"));
  const key = join(dir, "k.pem"), cert = join(dir, "c.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key,
    "-out", cert, "-days", "1", "-nodes", "-subj", `/CN=${cn}`], { stdio: "pipe" });
  const received = [];
  const server = https.createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (handler) return handler(req, res, body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ memoryId: "ok" }));
      });
    }
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    origin: `https://127.0.0.1:${server.address().port}`,
    subject: new X509Certificate(readFileSync(cert)).subject,
    received,
    close: () => new Promise((r) => server.close(r))
  };
}

/**
 * A GoodMem server holding memories in a Map, for the sync tests.
 *
 * A memory is PENDING for `processingMs` after it is created, then COMPLETED
 * (or whatever `faults.processing` said at create time). Only a processed
 * memory counts as retrievable, as on the real server. After every create and
 * delete, `timeline` records how many retrievable memories each note has, so
 * a test can see whether a note ever had none. `faults.create`, `.get` and
 * `.delete` are functions of the memory id returning a status to answer with
 * instead, or nothing.
 */
export async function fakeGoodMem({ processingMs = 50 } = {}) {
  const memories = new Map();
  const faults = { create: null, get: null, delete: null, processing: "COMPLETED" };
  const timeline = [];
  const statusOf = (m) => (Date.now() - m.createdAt >= processingMs ? m.final : "PENDING");
  const retrievable = (path) =>
    [...memories.values()].filter((m) => m.path === path && statusOf(m) === "COMPLETED").length;
  const record = (op, path) => timeline.push({ op, path, retrievable: retrievable(path) });
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const server = await selfSignedServer("localhost", (req, res, body) => {
    const byId = (req.url ?? "").match(/^\/v1\/memories\/([^/]+)$/);
    const id = byId ? decodeURIComponent(byId[1]) : undefined;
    if (req.method === "POST" && req.url === "/v1/memories") {
      const p = JSON.parse(body);
      const injected = faults.create?.(p.memoryId);
      if (injected) return send(res, injected, { error: "injected by the test" });
      if (memories.has(p.memoryId)) return send(res, 409, { error: `Memory with ID ${p.memoryId} already exists` });
      memories.set(p.memoryId, {
        memoryId: p.memoryId, spaceId: p.spaceId, content: p.originalContent,
        path: p.metadata?.source_path, createdAt: Date.now(), final: faults.processing
      });
      record("POST", p.metadata?.source_path);
      return send(res, 201, { memoryId: p.memoryId, spaceId: p.spaceId, processingStatus: "PENDING" });
    }
    if (req.method === "GET" && id) {
      const injected = faults.get?.(id);
      if (injected) return send(res, injected, { error: "injected by the test" });
      const m = memories.get(id);
      if (!m) return send(res, 404, { error: "Memory not found" });
      return send(res, 200, { memoryId: id, spaceId: m.spaceId, processingStatus: statusOf(m) });
    }
    if (req.method === "DELETE" && id) {
      const injected = faults.delete?.(id);
      if (injected) return send(res, injected, { error: "injected by the test" });
      const m = memories.get(id);
      if (!m) return send(res, 404, { error: "Memory not found" });
      memories.delete(id);
      record("DELETE", m.path);
      return send(res, 204);
    }
    send(res, 404, { error: "no such route in the fake" });
  });
  return {
    ...server,
    memories,
    faults,
    timeline,
    /** The memories holding one note. */
    of: (path) => [...memories.values()].filter((m) => m.path === path),
    /** "METHOD /path" for every request, with a memory id shown as "{id}". */
    requests: () => server.received.map((r) => `${r.method} ${r.url.replace(/\/v1\/memories\/.+/, "/v1/memories/{id}")}`),
  };
}
