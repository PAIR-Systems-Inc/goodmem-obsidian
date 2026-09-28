import { App, TFile } from "obsidian";
import { v4 as uuidv4, v5 as uuidv5 } from "uuid";
import { GoodMemApiClient } from "./goodmemApiClient";
import { hostOf } from "./goodmemEndpoints";
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
  /** Accept a self-signed certificate for the configured server host only. */
  allowSelfSignedCert: boolean;
}

export type StatusReporter = (text: string) => void;

/**
 * Which memory holds a note. The plugin keeps these in data.json so that a
 * re-save, even after a restart, knows which memory it replaces.
 */
export interface SyncedNote {
  /** The memory holding the note's latest synced content. */
  memoryId: string;
  /**
   * Older memories of the note that are not deleted yet: the delete failed,
   * or the new memory was not confirmed as processed. The note's next sync
   * deletes them once its own new memory is processed.
   */
  staleMemoryIds?: string[];
}

export interface SyncStateStore {
  /** Keyed by vault path. SyncManager updates it in place, then calls save(). */
  readonly notes: Record<string, SyncedNote>;
  save(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;

// How long a re-save waits for GoodMem to process the new memory before it
// deletes the one being replaced. About 2 s for a short note on a local server.
const PROCESSING_WAIT_MS = 60_000;

// Up to 0.2.0 every note was stored under uuidv5(vault + path) in this
// namespace. New memories get a random id; this is only used to find and
// replace a memory written by those versions. Keep it stable.
const MEMORY_ID_NAMESPACE_UUID = "6d329a2c-0a8e-45d1-bf5e-9f28c07d5b7c";

type Processing = { status: "COMPLETED" | "FAILED" } | { status: "UNCONFIRMED"; reason: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

type FileSyncState = {
  timerId?: number;
  inFlight: boolean;
  pending: boolean;
  // Called with the run's failure, if any, so a caller that waited on the
  // run learns whether it worked. A waiter resolved with no argument succeeded.
  waiters: Array<(failure?: unknown) => void>;
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
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: App,
    private getSettings: () => GoodMemSyncSettings,
    statusReporter?: StatusReporter,
    private readonly store: SyncStateStore = { notes: {}, save: async () => {} }
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

  private legacyMemoryIdForPath(vaultName: string, normalizedPath: string): string {
    const name = `obsidian:${vaultName}:${normalizedPath}`;
    return uuidv5(name, MEMORY_ID_NAMESPACE_UUID);
  }

  /** Save the note records, one write at a time. */
  private persist(): Promise<void> {
    this.persistQueue = this.persistQueue.then(() =>
      this.store.save().catch((err: unknown) => {
        console.error("[GoodMem] Could not save the synced-note records to data.json", err);
      })
    );
    return this.persistQueue;
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

  /**
   * Sync one file and wait for the result. Rejects if the upload failed, so a
   * caller counting outcomes (the initial sync) counts it as a failure.
   */
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

    return new Promise((resolve, reject) => {
      state.waiters.push((failure) => (failure === undefined ? resolve() : reject(failure)));
    });
  }

  private resolveWaitersIfIdle(normalizedPath: string, state: FileSyncState, failure?: unknown): void {
    if (state.timerId !== undefined) return;
    if (state.inFlight) return;
    if (state.pending) return;
    if (state.waiters.length === 0) return;
    const waiters = state.waiters.slice();
    state.waiters.length = 0;
    for (const w of waiters) w(failure);
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

    // A failed upload used to be indistinguishable from a successful one to
    // anyone awaiting syncNow(): the waiters were resolved either way, so the
    // initial sync counted every file as "ok". The failure is now handed to
    // the waiters and syncNow() rejects with it.
    let failure: unknown;
    try {
      await this.syncOnce(file, settings);
    } catch (err: unknown) {
      failure = err;
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
      this.resolveWaitersIfIdle(normalizedPath, state, failure);
      this.emitStatus();
    }
  }

  private async syncOnce(file: TFile, settings: GoodMemSyncSettings): Promise<void> {
    if (this.disposed) return;
    const vaultName = this.app.vault.getName();
    const normalizedPath = file.path;

    const content = await this.app.vault.cachedRead(file);
    const tags = extractAllTags(content);
    const updatedAtIso = new Date().toISOString();

    const client = new GoodMemApiClient({
      serverUrl: settings.serverUrl,
      apiKey: settings.apiKey,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxRetries: DEFAULT_MAX_RETRIES,
      logger: settings.enableDebugLogging
        ? { debug: (m: string) => console.debug(m) }
        : undefined,
      allowSelfSignedHost: settings.allowSelfSignedCert
        ? hostOf(settings.serverUrl)
        : undefined
    });

    // GoodMem has no update endpoint, so a re-save is a new memory plus a
    // delete of the old one. Up to 0.2.0 the delete came first, under an id
    // derived from the path, and a create that then failed left the note with
    // no memory at all. Now the new memory is created first, under a fresh
    // id, and the old one is deleted only once the new one is processed.
    const previous =
      this.store.notes[normalizedPath] ?? (await this.findLegacyMemory(client, vaultName, normalizedPath));
    const memoryId = uuidv4();

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

    // If this throws, nothing has been deleted and the note's record still
    // names the previous memory.
    try {
      await client.createMemory(payload);
    } catch (err) {
      // The id is new to this save, so it can only exist already if an
      // earlier attempt of this same request reached the server and its
      // response was lost: the HTTP client retries timeouts and 5xx.
      if (!this.isAlreadyExistsError(err)) throw err;
    }

    if (!previous) {
      this.store.notes[normalizedPath] = { memoryId };
      await this.persist();
      return;
    }

    // Record the new memory before deleting anything, with the ones it
    // replaces listed as stale: if a delete fails, or Obsidian quits part-way,
    // the next sync of this note still knows what to remove.
    const superseded = [previous.memoryId, ...(previous.staleMemoryIds ?? [])].filter((id) => id !== memoryId);
    this.store.notes[normalizedPath] = { memoryId, staleMemoryIds: superseded };
    await this.persist();

    // A memory is not retrievable until GoodMem has processed it, so deleting
    // the old one straight after the create would leave a window in which
    // retrieval finds neither version.
    const processing = await this.waitUntilProcessed(client, memoryId);
    if (processing.status === "FAILED") {
      await this.restorePrevious(client, normalizedPath, previous, memoryId);
      throw new Error(
        `GoodMem could not process the new version of ${normalizedPath} (processingStatus FAILED); ` +
          "the previously synced version is kept"
      );
    }
    if (processing.status === "UNCONFIRMED") {
      const why = `the new memory was not confirmed as processed: ${processing.reason}`;
      this.reportStale(normalizedPath, superseded.length, why);
      return;
    }
    await this.deleteSuperseded(client, normalizedPath, superseded);
  }

  /**
   * Up to 0.2.0 a note's memory id was derived from its path and nothing was
   * recorded. A note with no record may still have a memory under that id,
   * and if so it is the one to replace.
   */
  private async findLegacyMemory(
    client: GoodMemApiClient,
    vaultName: string,
    normalizedPath: string
  ): Promise<SyncedNote | undefined> {
    const legacyId = this.legacyMemoryIdForPath(vaultName, normalizedPath);
    return (await client.getMemory(legacyId)) ? { memoryId: legacyId } : undefined;
  }

  /** Poll a new memory until GoodMem has processed it, or give up. */
  private async waitUntilProcessed(client: GoodMemApiClient, memoryId: string): Promise<Processing> {
    const deadline = Date.now() + PROCESSING_WAIT_MS;
    for (let attempt = 0; ; attempt++) {
      await sleep(Math.min(1000, 250 * Math.pow(2, attempt)));
      if (this.disposed) return { status: "UNCONFIRMED", reason: "the plugin was unloaded" };
      let status: string | undefined;
      try {
        const memory = await client.getMemory(memoryId);
        if (!memory) return { status: "UNCONFIRMED", reason: "it is no longer on the server" };
        status = memory.processingStatus;
      } catch (err) {
        return { status: "UNCONFIRMED", reason: (err as any)?.message ?? String(err) };
      }
      if (status === "COMPLETED" || status === "FAILED") return { status };
      if (Date.now() >= deadline) {
        return { status: "UNCONFIRMED", reason: `still ${status ?? "unknown"} after ${PROCESSING_WAIT_MS / 1000}s` };
      }
    }
  }

  /** Delete the memories a new one replaced; any that fail stay recorded for the next sync. */
  private async deleteSuperseded(client: GoodMemApiClient, normalizedPath: string, ids: string[]): Promise<void> {
    const remaining: string[] = [];
    let lastError: unknown;
    for (const id of ids) {
      try {
        await client.deleteMemory(id); // A 404 means it is already gone, which is the goal.
      } catch (err) {
        remaining.push(id);
        lastError = err;
      }
    }
    const record = this.store.notes[normalizedPath];
    if (record) {
      if (remaining.length > 0) record.staleMemoryIds = remaining;
      else delete record.staleMemoryIds;
    }
    await this.persist();
    if (remaining.length > 0) this.reportStale(normalizedPath, remaining.length, lastError);
  }

  /**
   * The new memory failed processing and will never be retrievable, so the
   * note goes back to the memory it had, and the failed one is removed.
   */
  private async restorePrevious(
    client: GoodMemApiClient,
    normalizedPath: string,
    previous: SyncedNote,
    failedId: string
  ): Promise<void> {
    let restored = previous;
    try {
      await client.deleteMemory(failedId);
    } catch (err) {
      console.warn(`[GoodMem] Could not delete the unprocessed memory ${failedId} of ${normalizedPath}`, err);
      restored = { ...previous, staleMemoryIds: [...(previous.staleMemoryIds ?? []), failedId] };
    }
    this.store.notes[normalizedPath] = restored;
    await this.persist();
  }

  /** The note is synced, but older copies of it are still on the server. */
  private reportStale(normalizedPath: string, count: number, reason: unknown): void {
    const why = (reason as any)?.message ?? String(reason);
    console.warn(
      `[GoodMem] Synced ${normalizedPath}, but ${count} older ${count === 1 ? "memory" : "memories"} of it ` +
        `could not be deleted yet (${why}); the next sync of this note retries.`,
      reason
    );
    if (this.disposed) return;
    this.notices.show(
      `GoodMem Sync: "${normalizedPath}" is synced, but its previous version is still in GoodMem. ` +
        "The next sync of this note removes it."
    );
  }

  private isAlreadyExistsError(err: unknown): boolean {
    if (!(err instanceof HttpError)) return false;
    if (err.status === 409) return true;
    if (!err.responseBodyText) return false;
    return err.responseBodyText.includes("ALREADY_EXISTS");
  }

  dispose(): void {
    this.disposed = true;
    this.notices.dispose();
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
