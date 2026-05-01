import { CreateMemoryRequest, CreateMemoryResponse } from "./goodmemTypes";
import { memoriesCollectionUrl, memoryUrl, normalizeGoodMemBaseUrl } from "./goodmemEndpoints";
import { GoodMemHttpClient, HttpError, HttpLogger } from "./http";

export class GoodMemApiClient {
  private readonly baseUrl: string;
  private readonly http: GoodMemHttpClient;

  constructor(opts: {
    serverUrl: string;
    apiKey: string;
    timeoutMs?: number;
    maxRetries?: number;
    logger?: HttpLogger;
  }) {
    this.baseUrl = normalizeGoodMemBaseUrl(opts.serverUrl);
    this.http = new GoodMemHttpClient({
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs ?? 15_000,
      maxRetries: opts.maxRetries ?? 3,
      logger: opts.logger
    });
  }

  async deleteMemory(memoryId: string): Promise<void> {
    try {
      await this.http.requestJson("DELETE", memoryUrl(this.baseUrl, memoryId));
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return; // Treat NOT_FOUND as success.
      throw err;
    }
  }

  async createMemory(payload: CreateMemoryRequest): Promise<CreateMemoryResponse> {
    const resp = await this.http.requestJson<CreateMemoryResponse>(
      "POST",
      memoriesCollectionUrl(this.baseUrl),
      payload
    );
    if (!resp.json) throw new Error("GoodMem createMemory: missing JSON response");
    return resp.json;
  }
}

