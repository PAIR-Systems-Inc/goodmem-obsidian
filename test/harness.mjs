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
  return { parseYaml, TFile, Notice };
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
