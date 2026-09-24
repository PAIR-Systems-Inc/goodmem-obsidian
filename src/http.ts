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
  /**
   * Hostname (or "host:port") whose self-signed certificate the user has
   * explicitly chosen to accept. Certificates are verified for every other
   * host, always. Undefined means verify everywhere.
   */
  allowSelfSignedHost?: string;
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

/**
 * Does `host` match the host the user opted out of verification for?
 *
 * Compared after normalising case and a default port, and only ever against
 * the one host in settings: an opt-out for a local server must not silently
 * extend to a redirect or a misconfiguration pointing somewhere else.
 */
export function isExemptHost(host: string, allowSelfSignedHost: string | undefined): boolean {
  if (!allowSelfSignedHost) return false;
  const normalise = (h: string) => h.trim().toLowerCase().replace(/:443$/, "");
  return normalise(host) === normalise(allowSelfSignedHost);
}

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
  allowInsecure: boolean
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
      // Verified unless the user explicitly exempted exactly this host. The
      // plugin uploads note bodies and the API key, so accepting any
      // certificate from any host would hand both to anyone able to
      // intercept the connection.
      rejectUnauthorized: !allowInsecure
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
  private readonly allowSelfSignedHost?: string;

  constructor(opts: HttpClientOptions) {
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs;
    this.maxRetries = opts.maxRetries;
    this.logger = opts.logger;
    this.allowSelfSignedHost = opts.allowSelfSignedHost;
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

        const allowInsecure = isExemptHost(host, this.allowSelfSignedHost);
        const resp = await nodeRequest(
          method,
          url,
          headers,
          bodyStr,
          this.timeoutMs,
          controller.signal,
          allowInsecure
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
        // A non-retryable HTTP status was already decided above and thrown
        // from inside this try; it must not fall into the network-error
        // retry below, or a 400 or a 409 is re-sent maxRetries more times.
        if (err instanceof HttpError) throw err;

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
