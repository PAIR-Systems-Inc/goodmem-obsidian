import { Notice } from "obsidian";

export class NoticeLimiter {
  private lastShownAtMs = 0;
  private suppressedCount = 0;
  private latestSuppressed?: string;
  private flushTimerId?: number;

  constructor(private readonly minIntervalMs: number) {}

  show(message: string): void {
    const sinceLastMs = Date.now() - this.lastShownAtMs;
    if (sinceLastMs < this.minIntervalMs) {
      // Up to 0.2.0 a notice inside the interval was dropped, and only counted
      // on whichever notice came next, if any did. A failed sync right after
      // another notice was never shown. The latest one is now shown when the
      // interval ends.
      this.suppressedCount++;
      this.latestSuppressed = message;
      if (this.flushTimerId === undefined) {
        this.flushTimerId = window.setTimeout(() => this.flush(), this.minIntervalMs - sinceLastMs);
      }
      return;
    }
    this.display(message);
  }

  /** Stop a pending notice from appearing, e.g. after the plugin is unloaded. */
  dispose(): void {
    if (this.flushTimerId !== undefined) window.clearTimeout(this.flushTimerId);
    this.flushTimerId = undefined;
    this.latestSuppressed = undefined;
    this.suppressedCount = 0;
  }

  private flush(): void {
    this.flushTimerId = undefined;
    const message = this.latestSuppressed;
    if (message === undefined) return;
    this.suppressedCount--; // It is being shown after all.
    this.display(message);
  }

  private display(message: string): void {
    if (this.flushTimerId !== undefined) window.clearTimeout(this.flushTimerId);
    this.flushTimerId = undefined;
    this.latestSuppressed = undefined;
    this.lastShownAtMs = Date.now();
    const suffix = this.suppressedCount > 0 ? ` (suppressed ${this.suppressedCount})` : "";
    this.suppressedCount = 0;
    new Notice(`${message}${suffix}`);
  }
}
