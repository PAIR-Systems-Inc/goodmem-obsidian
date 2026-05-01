import { Notice } from "obsidian";

export class NoticeLimiter {
  private lastShownAtMs = 0;
  private suppressedCount = 0;

  constructor(private readonly minIntervalMs: number) {}

  show(message: string): void {
    const now = Date.now();
    if (now - this.lastShownAtMs < this.minIntervalMs) {
      this.suppressedCount++;
      return;
    }

    this.lastShownAtMs = now;
    const suffix = this.suppressedCount > 0 ? ` (suppressed ${this.suppressedCount})` : "";
    this.suppressedCount = 0;
    new Notice(`${message}${suffix}`);
  }
}

