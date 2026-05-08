import * as http from "http";
import * as https from "https";

export type HttpMethod = "GET" | "POST" | "DELETE";

export interface HttpLogger {
  debug(message: string): void;
  warn?(message: string): void;
}

export interface HttpClientOptions {
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  logger?: HttpLogger;
}

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly responseBodyText?: string;

  constructor(message: string, opts: { status: number; url: string; responseBodyText?: string }) {
    super(message);
    this.name = "HttpError";
    this.status = opts.status;
    this.url = opts.url;
    this.responseBodyText = opts.responseBodyText;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function backoffMs(attempt: number): number {
  // Exponential backoff with jitter, capped.
  const base = Math.min(4000, 250 * Math.pow(2, attempt));
  const jitter = Math.random() * 0.25 * base;
  return base + jitter;
}

// Module-scoped so the warning fires at most once per host for the whole plugin
// lifetime — every sync creates a fresh client, and a per-instance Set would
// re-warn on every request.
const insecureWarnedHosts = new Set<string>();

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

function nodeRequest(
  method: HttpMethod,
  urlStr: string,
  reqHeaders: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  signal: AbortSignal,
  onInsecureCert: () => void
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch (e) {
      reject(e);
      return;
    }

    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const opts: https.RequestOptions = {
      method,
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      headers: reqHeaders,
      timeout: timeoutMs,
      // Accept invalid/self-signed TLS certs; we log a debug line on first occurrence per host.
      rejectUnauthorized: false
    };

    const req = lib.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer | string) => {
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      });
      res.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
          else if (v != null) headers[k.toLowerCase()] = String(v);
        }
        resolve({
          status: res.statusCode ?? 0,
          headers,
          bodyText: Buffer.concat(chunks).toString("utf8")
        });
      });
      res.on("error", reject);
    });

    if (isHttps) {
      req.on("socket", (socket: any) => {
        const check = () => {
          if (typeof socket.authorized === "boolean" && socket.authorized === false) {
            onInsecureCert();
          }
        };
        socket.on("secureConnect", check);
      });
    }

    req.on("timeout", () => {
      req.destroy(Object.assign(new Error("Request timed out"), { name: "AbortError" }));
    });
    req.on("error", reject);

    const onAbort = () => {
      req.destroy(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    if (body !== undefined) req.write(body);
    req.end();
  });
}

export class GoodMemHttpClient {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly logger?: HttpLogger;

  constructor(opts: HttpClientOptions) {
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs;
    this.maxRetries = opts.maxRetries;
    this.logger = opts.logger;
  }

  private warnInsecureCert(host: string): void {
    if (insecureWarnedHosts.has(host)) return;
    insecureWarnedHosts.add(host);
    const msg = `[GoodMem] accepting invalid TLS certificate for ${host}`;
    // Use console.debug — we already gate to once-per-host, and Obsidian's
    // "plugin failed, output suppressed" indicator triggers on repeated
    // console.warn/error from a plugin.
    if (this.logger?.warn) this.logger.warn(msg);
    else console.debug(msg);
  }

  async requestJson<TResponse>(
    method: HttpMethod,
    url: string,
    body?: unknown
  ): Promise<{ status: number; json?: TResponse; text?: string }> {
    const startedAt = Date.now();
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // ignore; fall back to raw url
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const headers: Record<string, string> = {
          "x-api-key": this.apiKey
        };
        if (bodyStr !== undefined) headers["Content-Type"] = "application/json";

        const resp = await nodeRequest(
          method,
          url,
          headers,
          bodyStr,
          this.timeoutMs,
          controller.signal,
          () => this.warnInsecureCert(host)
        );

        const elapsedMs = Date.now() - startedAt;
        this.logger?.debug(`[GoodMem] ${method} ${url} -> ${resp.status} (${elapsedMs}ms)`);

        const contentType = resp.headers["content-type"] ?? "";
        const hasJson = contentType.includes("application/json");
        const ok = resp.status >= 200 && resp.status < 300;

        if (ok) {
          if (resp.status === 204) return { status: resp.status };
          if (hasJson) {
            try {
              return { status: resp.status, json: JSON.parse(resp.bodyText) as TResponse };
            } catch {
              return { status: resp.status, text: resp.bodyText };
            }
          }
          return { status: resp.status, text: resp.bodyText };
        }

        if (attempt < this.maxRetries && isRetryableStatus(resp.status)) {
          await sleep(backoffMs(attempt));
          continue;
        }

        throw new HttpError(`HTTP ${resp.status}`, {
          status: resp.status,
          url,
          responseBodyText: resp.bodyText
        });
      } catch (err: unknown) {
        const elapsedMs = Date.now() - startedAt;
        const isAbort =
          (err instanceof Error && err.name === "AbortError") ||
          (err instanceof DOMException && err.name === "AbortError");
        const message = isAbort ? "Request timed out" : (err as any)?.message ?? String(err);

        // Network errors should be retried; keep the last error if we run out.
        if (attempt < this.maxRetries) {
          this.logger?.debug(`[GoodMem] ${method} ${url} -> error (${elapsedMs}ms): ${message}`);
          await sleep(backoffMs(attempt));
          continue;
        }

        throw err;
      } finally {
        window.clearTimeout(timeoutId);
      }
    }

    // Unreachable.
    throw new Error("requestJson: exhausted retries unexpectedly");
  }
}
