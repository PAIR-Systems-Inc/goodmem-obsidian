import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule, obsidian } from "./harness.mjs";

// SyncManager schedules with window.setTimeout; outside Obsidian there is no window.
globalThis.window ??= globalThis;

const { SyncManager } = loadModule("src/syncManager.ts");

function vaultOf(paths) {
  const files = paths.map((p) => new obsidian.TFile(p));
  return {
    vault: {
      getName: () => "vault",
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (p) => files.find((f) => f.path === p) ?? null,
      cachedRead: async () => "# note",
    },
  };
}

const settings = () => ({
  serverUrl: "https://goodmem.test",
  apiKey: "test-key",
  spaceId: "00000000-0000-4000-8000-000000000000",
  debounceMs: 0,
  initialSyncConcurrency: 1,
  initialSyncOnStartup: false,
});

/** A manager whose upload succeeds for every path except the ones named. */
function managerFailingOn(failingPaths, paths) {
  const manager = new SyncManager(vaultOf(paths), settings);
  manager.syncOnce = async (file) => {
    if (failingPaths.includes(file.path)) throw new Error(`HTTP 400 for ${file.path}`);
  };
  return manager;
}

test("syncNow rejects when the upload failed", async () => {
  const manager = managerFailingOn(["bad.md"], ["bad.md"]);
  await assert.rejects(() => manager.syncNow("bad.md"), /HTTP 400 for bad\.md/);
  manager.dispose();
});

test("syncNow resolves when the upload succeeded", async () => {
  const manager = managerFailingOn([], ["good.md"]);
  await manager.syncNow("good.md");
  manager.dispose();
});

test("the initial sync counts a failed upload as failed, not as ok", async () => {
  // 0.1.0 resolved syncNow() either way, so this reported "2 ok, 0 failed".
  const manager = managerFailingOn(["bad.md"], ["good.md", "bad.md"]);
  let last;
  await manager.initialSyncAllMarkdownFiles({ onProgress: (p) => (last = p) });
  assert.deepEqual(
    { done: last.done, total: last.total, succeeded: last.succeeded, failed: last.failed },
    { done: 2, total: 2, succeeded: 1, failed: 1 },
  );
  manager.dispose();
});

test("the completion notice reports the real counts", async () => {
  const manager = managerFailingOn(["bad.md"], ["good.md", "bad.md"]);
  // NoticeLimiter drops any notice within 60s of the last one, which would
  // hide "complete" behind "started"; capture the messages directly.
  const shown = [];
  manager.notices = { show: (m) => shown.push(m) };
  await manager.initialSyncAllMarkdownFiles();
  const done = shown.find((m) => m.includes("initial sync complete"));
  assert.ok(done, `no completion notice among: ${JSON.stringify(shown)}`);
  assert.match(done, /1 ok, 1 failed/);
  manager.dispose();
});
