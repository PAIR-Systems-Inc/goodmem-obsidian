export type HttpMethod = "GET" | "POST" | "DELETE";

export interface HttpLogger {
  debug(message: string): void;
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

  async requestJson<TResponse>(
    method: HttpMethod,
    url: string,
    body?: unknown
  ): Promise<{ status: number; json?: TResponse; text?: string }> {
    const startedAt = Date.now();

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const resp = await fetch(url, {
          method,
          headers: {
            "x-api-key": this.apiKey,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {})
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal
        });

        const elapsedMs = Date.now() - startedAt;
        this.logger?.debug(`[GoodMem] ${method} ${url} -> ${resp.status} (${elapsedMs}ms)`);

        const contentType = resp.headers.get("content-type") ?? "";
        const hasJson = contentType.includes("application/json");

        if (resp.ok) {
          if (resp.status === 204) return { status: resp.status };
          if (hasJson) return { status: resp.status, json: (await resp.json()) as TResponse };
          return { status: resp.status, text: await resp.text() };
        }

        const responseBodyText = await resp.text().catch(() => undefined);
        if (attempt < this.maxRetries && isRetryableStatus(resp.status)) {
          await sleep(backoffMs(attempt));
          continue;
        }

        throw new HttpError(`HTTP ${resp.status}`, { status: resp.status, url, responseBodyText });
      } catch (err: unknown) {
        const elapsedMs = Date.now() - startedAt;
        const isAbort = err instanceof DOMException && err.name === "AbortError";
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

