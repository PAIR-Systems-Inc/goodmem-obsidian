import { App, TFile } from "obsidian";
import { v5 as uuidv5 } from "uuid";
import { GoodMemApiClient } from "./goodmemApiClient";
import { CreateMemoryRequest } from "./goodmemTypes";
import { HttpError } from "./http";
import { extractAllTags } from "./tags";
import { NoticeLimiter } from "./noticeLimiter";

export interface GoodMemSyncSettings {
  serverUrl: string;
  apiKey: string;
  spaceId: string;
  debounceMs: number;
  enableDebugLogging: boolean;
  initialSyncOnStartup: boolean;
  initialSyncConcurrency: number;
}

export type StatusReporter = (text: string) => void;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;

// Keep stable forever; changing it would change all derived memory IDs.
const MEMORY_ID_NAMESPACE_UUID = "6d329a2c-0a8e-45d1-bf5e-9f28c07d5b7c";

type FileSyncState = {
  timerId?: number;
  inFlight: boolean;
  pending: boolean;
  waiters: Array<() => void>;
};

export class SyncManager {
  private readonly states = new Map<string, FileSyncState>();
  private readonly notices = new NoticeLimiter(60_000);
  private disposed = false;
  private bulkSyncInProgress = false;
  private inFlightCount = 0;
  private queuedCount = 0;
  private lastQueuedPath?: string;
  private lastActivePath?: string;
  private statusReporter?: StatusReporter;

  constructor(
    private readonly app: App,
    private getSettings: () => GoodMemSyncSettings,
    statusReporter?: StatusReporter
  ) {
    this.statusReporter = statusReporter;
    this.emitStatus();
  }

  setStatusReporter(statusReporter?: StatusReporter): void {
    this.statusReporter = statusReporter;
    this.emitStatus();
  }

  queueSync(normalizedPath: string): void {
    if (this.disposed) return;
    const settings = this.getSettings();
    const state = this.states.get(normalizedPath) ?? { inFlight: false, pending: false, waiters: [] };
    this.states.set(normalizedPath, state);

    if (state.inFlight) {
      // A save happened while syncing; run once again after the current run completes.
      if (!state.pending) {
        state.pending = true;
        this.queuedCount++;
        this.lastQueuedPath = normalizedPath;
        this.emitStatus();
      }
      return;
    }

    this.clearTimer(state);
    state.timerId = window.setTimeout(() => {
      void this.runSync(normalizedPath);
    }, Math.max(0, settings.debounceMs ?? 0));
    this.queuedCount++;
    this.lastQueuedPath = normalizedPath;
    this.emitStatus();
  }

  async initialSyncAllMarkdownFiles(opts?: {
    onProgress?: (p: {
      done: number;
      total: number;
      succeeded: number;
      failed: number;
      currentPath?: string;
    }) => void;
  }): Promise<void> {
    if (this.disposed) return;
    if (this.bulkSyncInProgress) {
      this.notices.show("GoodMem Sync: initial sync already running.");
      return;
    }

    const settings = this.getSettings();
    const validationError = this.validateSettings(settings);
    if (validationError) {
      this.notices.show(validationError);
      return;
    }

    const files = this.app.vault.getMarkdownFiles();
    const paths = files.map((f) => f.path).filter((p) => !p.startsWith(".obsidian/"));
    if (paths.length === 0) {
      this.notices.show("GoodMem Sync: no Markdown files found.");
      return;
    }

    const concurrency = Math.max(1, Math.floor(settings.initialSyncConcurrency || 1));
    this.bulkSyncInProgress = true;
    this.notices.show(`GoodMem Sync: initial sync started (${paths.length} files).`);

    let index = 0;
    let succeeded = 0;
    let failed = 0;
    let lastProgressAtMs = 0;

    const maybeReportProgress = (currentPath?: string) => {
      const done = succeeded + failed;
      const now = Date.now();
      if (done < paths.length && now - lastProgressAtMs < 250) return;
      lastProgressAtMs = now;
      opts?.onProgress?.({ done, total: paths.length, succeeded, failed, currentPath });
    };

    maybeReportProgress();

    const workers = Array.from({ length: concurrency }, async () => {
      while (!this.disposed) {
        const path = paths[index++];
        if (!path) break;
        try {
          await this.syncNow(path);
          succeeded++;
        } catch (err) {
          failed++;
          const message = (err as any)?.message ?? String(err);
          this.debug(`[GoodMem] Initial sync failed for ${path}: ${message}`);
        } finally {
          maybeReportProgress(path);
        }
      }
    });

    try {
      await Promise.all(workers);
      maybeReportProgress();
      this.notices.show(`GoodMem Sync: initial sync complete (${succeeded} ok, ${failed} failed).`);
    } finally {
      this.bulkSyncInProgress = false;
      this.emitStatus();
    }
  }

  private debug(message: string): void {
    if (this.getSettings().enableDebugLogging) console.debug(message);
  }

  private emitStatus(): void {
    if (!this.statusReporter) return;
    if (this.bulkSyncInProgress) return;

    const label = (path?: string) => {
      if (!path) return "…";
      const parts = path.split("/");
      return parts[parts.length - 1] || path;
    };

    if (this.inFlightCount > 0) {
      this.statusReporter(`GoodMem: syncing ${label(this.lastActivePath)}`);
      return;
    }
    if (this.queuedCount > 0) {
      this.statusReporter(`GoodMem: queued ${label(this.lastQueuedPath)}`);
      return;
    }
    this.statusReporter("GoodMem: idle");
  }

  private clearTimer(state: FileSyncState): void {
    if (state.timerId === undefined) return;
    window.clearTimeout(state.timerId);
    state.timerId = undefined;
    this.queuedCount = Math.max(0, this.queuedCount - 1);
  }

  private getFile(normalizedPath: string): TFile | null {
    const af = this.app.vault.getAbstractFileByPath(normalizedPath);
    return af instanceof TFile ? af : null;
  }

  private validateSettings(settings: GoodMemSyncSettings): string | null {
    if (!settings.serverUrl.trim()) return "GoodMem Sync: serverUrl is not set";
    if (!settings.apiKey.trim()) return "GoodMem Sync: apiKey is not set";
    if (!settings.spaceId.trim()) return "GoodMem Sync: spaceId is not set";
    return null;
  }

  private memoryIdForPath(vaultName: string, normalizedPath: string): string {
    const name = `obsidian:${vaultName}:${normalizedPath}`;
    return uuidv5(name, MEMORY_ID_NAMESPACE_UUID);
  }

  private buildMetadata(opts: {
    vaultName: string;
    normalizedPath: string;
    title: string;
    updatedAtIso: string;
    tags: string[];
  }): Record<string, any> {
    const folderLabels = opts.normalizedPath.split("/").slice(0, -1).filter(Boolean);
    return {
      source: "obsidian",
      vault: opts.vaultName,
      source_path: opts.normalizedPath,
      title: opts.title,
      updated_at: opts.updatedAtIso,
      tags: opts.tags,
      path_labels: folderLabels
    };
  }

  async syncNow(normalizedPath: string): Promise<void> {
    const state = this.states.get(normalizedPath) ?? { inFlight: false, pending: false, waiters: [] };
    this.states.set(normalizedPath, state);

    this.clearTimer(state);
    this.emitStatus();

    // Ensure a run happens (or is scheduled as pending), then wait until idle.
    void this.runSync(normalizedPath);
    await this.waitUntilIdle(normalizedPath);
  }

  private waitUntilIdle(normalizedPath: string): Promise<void> {
    const state = this.states.get(normalizedPath);
    if (!state) return Promise.resolve();
    if (state.timerId === undefined && !state.inFlight && !state.pending) return Promise.resolve();

    return new Promise((resolve) => {
      state.waiters.push(resolve);
    });
  }

  private resolveWaitersIfIdle(normalizedPath: string, state: FileSyncState): void {
    if (state.timerId !== undefined) return;
    if (state.inFlight) return;
    if (state.pending) return;
    if (state.waiters.length === 0) return;
    const waiters = state.waiters.slice();
    state.waiters.length = 0;
    for (const w of waiters) w();
  }

  private async runSync(normalizedPath: string): Promise<void> {
    if (this.disposed) return;
    const state = this.states.get(normalizedPath);
    if (!state) return;

    // Timer firing means this queued item is now being processed.
    if (state.timerId !== undefined) {
      state.timerId = undefined;
      this.queuedCount = Math.max(0, this.queuedCount - 1);
    }

    if (state.pending) {
      state.pending = false;
      this.queuedCount = Math.max(0, this.queuedCount - 1);
    }

    if (state.inFlight) {
      if (!state.pending) {
        state.pending = true;
        this.queuedCount++;
      }
      this.lastQueuedPath = normalizedPath;
      this.emitStatus();
      this.resolveWaitersIfIdle(normalizedPath, state);
      return;
    }

    const settings = this.getSettings();
    const validationError = this.validateSettings(settings);
    if (validationError) {
      this.notices.show(validationError);
      this.emitStatus();
      this.resolveWaitersIfIdle(normalizedPath, state);
      return;
    }

    const file = this.getFile(normalizedPath);
    if (!file || file.extension !== "md") {
      this.emitStatus();
      this.resolveWaitersIfIdle(normalizedPath, state);
      return;
    }

    state.inFlight = true;
    this.inFlightCount++;
    state.pending = false;
    this.lastActivePath = normalizedPath;
    this.emitStatus();

    try {
      await this.syncOnce(file, settings);
    } catch (err: unknown) {
      const message = (err as any)?.message ?? String(err);
      console.error(`[GoodMem] Sync failed for ${normalizedPath}: ${message}`, err);
      this.notices.show(`GoodMem Sync failed for "${normalizedPath}". Check console for details.`);
    } finally {
      state.inFlight = false;
      this.inFlightCount = Math.max(0, this.inFlightCount - 1);
      if (state.pending) {
        state.pending = false;
        this.queuedCount = Math.max(0, this.queuedCount - 1);
        // Run once more immediately; the content read will reflect the latest save.
        void this.runSync(normalizedPath);
        return;
      }
      this.resolveWaitersIfIdle(normalizedPath, state);
      this.emitStatus();
    }
  }

  private async syncOnce(file: TFile, settings: GoodMemSyncSettings): Promise<void> {
    if (this.disposed) return;
    const vaultName = this.app.vault.getName();
    const normalizedPath = file.path;
    const memoryId = this.memoryIdForPath(vaultName, normalizedPath);

    const content = await this.app.vault.cachedRead(file);
    const tags = extractAllTags(content);
    const updatedAtIso = new Date().toISOString();

    const payload: CreateMemoryRequest = {
      memoryId,
      spaceId: settings.spaceId.trim(),
      originalContent: content,
      contentType: "text/markdown",
      metadata: this.buildMetadata({
        vaultName,
        normalizedPath,
        title: file.basename,
        updatedAtIso,
        tags
      })
    };

    const client = new GoodMemApiClient({
      serverUrl: settings.serverUrl,
      apiKey: settings.apiKey,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxRetries: DEFAULT_MAX_RETRIES,
      logger: settings.enableDebugLogging
        ? { debug: (m: string) => console.debug(m) }
        : undefined
    });

    // Delete-then-create makes the operation effectively idempotent with stable memoryId.
    await client.deleteMemory(memoryId);

    try {
      await client.createMemory(payload);
    } catch (err) {
      if (this.isAlreadyExistsError(err)) {
        // Delete lag or a race: delete again then retry once.
        await client.deleteMemory(memoryId);
        await client.createMemory(payload);
        return;
      }
      throw err;
    }
  }

  private isAlreadyExistsError(err: unknown): boolean {
    if (!(err instanceof HttpError)) return false;
    if (err.status === 409) return true;
    if (!err.responseBodyText) return false;
    return err.responseBodyText.includes("ALREADY_EXISTS");
  }

  dispose(): void {
    this.disposed = true;
    for (const state of this.states.values()) {
      if (state.waiters.length > 0) {
        const waiters = state.waiters.slice();
        state.waiters.length = 0;
        for (const w of waiters) w();
      }
    }
    for (const state of this.states.values()) {
      if (state.timerId !== undefined) window.clearTimeout(state.timerId);
    }
    this.states.clear();
    this.inFlightCount = 0;
    this.queuedCount = 0;
    this.emitStatus();
  }
}
