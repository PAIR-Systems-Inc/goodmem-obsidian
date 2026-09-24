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

/** Bundle a source module to CJS and require it. */
export function loadModule(entry) {
  const dir = mkdtempSync(join(tmpdir(), "gm-obsidian-"));
  const out = join(dir, "bundle.cjs");
  execFileSync("npx", ["esbuild", entry, "--bundle", "--platform=node",
    "--format=cjs", "--external:http", "--external:https", "--external:obsidian",
    `--outfile=${out}`], { stdio: "pipe" });
  // The plugin targets Obsidian's renderer, where `window` exists.
  globalThis.window ??= { setTimeout, clearTimeout };
  return require(out);
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
