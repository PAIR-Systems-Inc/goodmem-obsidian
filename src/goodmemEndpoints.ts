/**
 * GoodMem REST base path rules:
 * - All endpoints are relative to {serverUrl}/v1
 * - If user supplies a URL already ending with /v1 (or /v1/), don't double-add.
 */
export function normalizeGoodMemBaseUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  if (!trimmed) throw new Error("serverUrl is empty");

  // Remove trailing slashes for stable concatenation.
  const withoutTrailingSlash = trimmed.replace(/\/+$/, "");
  if (withoutTrailingSlash.endsWith("/v1")) return withoutTrailingSlash;
  return `${withoutTrailingSlash}/v1`;
}

export function memoriesCollectionUrl(baseUrl: string): string {
  return `${baseUrl}/memories`;
}

export function memoryUrl(baseUrl: string, memoryId: string): string {
  return `${baseUrl}/memories/${encodeURIComponent(memoryId)}`;
}

