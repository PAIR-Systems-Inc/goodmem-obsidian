import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadModule, obsidian, fakeGoodMem } from "./harness.mjs";

// SyncManager schedules with window.setTimeout; outside Obsidian there is no window.
globalThis.window ??= globalThis;

const { SyncManager } = loadModule("src/syncManager.ts");
const { v5: uuidv5 } = createRequire(import.meta.url)("uuid");

// GoodMem has no update endpoint, so re-saving a note means creating a new
// memory and deleting the old one. Up to 0.2.0 the delete came first: a create
// that then failed left the note with no memory at all (reproduced live on
// 2026-09-25 and again on 2026-09-28), and even a successful re-save left the
// note unretrievable until the new memory was processed.

const NOTE = "note.md";
const rev = (n) => `# Note\n\nRevision ${n}.`;

function vaultWith(contents) {
  const files = new Map(
    Object.keys(contents).map((p) => [p, Object.assign(new obsidian.TFile(p), { basename: p.replace(/\.md$/, "") })])
  );
  return {
    vault: {
      getName: () => "vault",
      getMarkdownFiles: () => [...files.values()],
      getAbstractFileByPath: (p) => files.get(p) ?? null,
      cachedRead: async (f) => contents[f.path],
    },
  };
}

describe("re-saving a note", () => {
  let server;
  before(async () => { server = await fakeGoodMem(); });
  after(async () => { await server.close(); });

  /** A manager syncing one note to the fake server, with an inspectable record store. */
  function setup() {
    server.memories.clear();
    server.received.length = 0;
    server.timeline.length = 0;
    Object.assign(server.faults, { create: null, get: null, delete: null, processing: "COMPLETED" });
    const contents = { [NOTE]: rev(1) };
    const store = { notes: {}, saves: 0, async save() { this.saves++; } };
    const settings = () => ({
      serverUrl: server.origin,
      apiKey: "test-key",
      spaceId: "00000000-0000-4000-8000-000000000000",
      debounceMs: 0,
      initialSyncConcurrency: 1,
      initialSyncOnStartup: false,
      enableDebugLogging: false,
      // The fake's certificate is self-signed; the exemption covers only its host.
      allowSelfSignedCert: true,
    });
    const manager = new SyncManager(vaultWith(contents), settings, undefined, store);
    const noticesBefore = obsidian.Notice.shown.length;
    return {
      manager,
      store,
      contents,
      notices: () => obsidian.Notice.shown.slice(noticesBefore),
      /** Sync the first revision and let the server process it. */
      async syncedOnce() {
        await manager.syncNow(NOTE);
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(server.of(NOTE).length, 1);
        server.timeline.length = 0;
        return server.of(NOTE)[0].memoryId;
      },
    };
  }

  test("ends with exactly one memory, holding the new content, and the note is never unretrievable", async () => {
    const { manager, store, contents, syncedOnce } = setup();
    const oldId = await syncedOnce();

    contents[NOTE] = rev(2);
    await manager.syncNow(NOTE);

    const left = server.of(NOTE);
    assert.equal(left.length, 1, "exactly one memory for the note");
    assert.equal(left[0].content, rev(2));
    // 0.2.0 deleted first, so the note had no retrievable memory from the
    // delete until the new memory was processed.
    assert.ok(server.timeline.length > 0);
    assert.deepEqual(
      server.timeline.filter((t) => t.retrievable === 0),
      [],
      `the note had no retrievable memory at some point: ${JSON.stringify(server.timeline)}`
    );
    assert.notEqual(left[0].memoryId, oldId, "the old memory is deleted, not overwritten");
    assert.deepEqual(store.notes[NOTE], { memoryId: left[0].memoryId });
    manager.dispose();
  });

  test("a failed create keeps the previous memory and its record, and the failure reaches the caller", async () => {
    const { manager, store, contents, notices, syncedOnce } = setup();
    const oldId = await syncedOnce();

    server.faults.create = () => 500;
    contents[NOTE] = rev(2);
    await assert.rejects(() => manager.syncNow(NOTE), /HTTP 500/);

    assert.deepEqual(server.of(NOTE).map((m) => [m.memoryId, m.content]), [[oldId, rev(1)]], "the old memory is still there");
    assert.deepEqual(store.notes[NOTE], { memoryId: oldId }, "the record still names the old memory");
    assert.ok(!server.requests().some((r) => r.startsWith("DELETE")), "nothing was deleted");
    assert.ok(notices().some((m) => m.includes(`failed for "${NOTE}"`)), `no failure notice among ${JSON.stringify(notices())}`);
    manager.dispose();
  });

  test("a failed delete leaves the old memory recorded and reported, and the next sync removes it", async () => {
    const { manager, store, contents, notices, syncedOnce } = setup();
    const oldId = await syncedOnce();

    server.faults.delete = () => 503;
    contents[NOTE] = rev(2);
    await manager.syncNow(NOTE); // The note is synced: this must not reject.

    const both = server.of(NOTE);
    assert.equal(both.length, 2, "old and new both exist: a duplicate, not a loss");
    const newId = both.find((m) => m.content === rev(2)).memoryId;
    assert.deepEqual(store.notes[NOTE], { memoryId: newId, staleMemoryIds: [oldId] });
    assert.ok(
      notices().some((m) => m.includes(`"${NOTE}" is synced, but its previous version is still in GoodMem`)),
      `no stale-memory notice among ${JSON.stringify(notices())}`
    );

    server.faults.delete = null;
    contents[NOTE] = rev(3);
    await manager.syncNow(NOTE);

    const left = server.of(NOTE);
    assert.deepEqual(left.map((m) => m.content), [rev(3)], "only the newest memory is left");
    assert.equal(server.memories.has(oldId), false, "the stale memory was retried and deleted");
    assert.deepEqual(store.notes[NOTE], { memoryId: left[0].memoryId });
    manager.dispose();
  });

  test("a 404 on the delete counts as deleted", async () => {
    const { manager, store, contents, notices, syncedOnce } = setup();
    const oldId = await syncedOnce();
    server.memories.delete(oldId); // Removed by someone else in the meantime.

    contents[NOTE] = rev(2);
    await manager.syncNow(NOTE);

    const left = server.of(NOTE);
    assert.deepEqual(left.map((m) => m.content), [rev(2)]);
    assert.deepEqual(store.notes[NOTE], { memoryId: left[0].memoryId }, "nothing is left to retry");
    assert.ok(!notices().some((m) => m.includes("previous version")), `unexpected notice: ${JSON.stringify(notices())}`);
    manager.dispose();
  });

  test("a new memory that fails processing is removed, and the previous one kept", async () => {
    const { manager, store, contents, syncedOnce } = setup();
    const oldId = await syncedOnce();

    server.faults.processing = "FAILED";
    contents[NOTE] = rev(2);
    await assert.rejects(() => manager.syncNow(NOTE), /processingStatus FAILED/);

    assert.deepEqual(server.of(NOTE).map((m) => [m.memoryId, m.content]), [[oldId, rev(1)]]);
    assert.deepEqual(store.notes[NOTE], { memoryId: oldId });
    manager.dispose();
  });

  test("a new memory not confirmed as processed keeps the old one, recorded for the next sync", async () => {
    const { manager, store, contents, notices, syncedOnce } = setup();
    const oldId = await syncedOnce();

    server.faults.get = (id) => (id === oldId ? null : 400);
    contents[NOTE] = rev(2);
    await manager.syncNow(NOTE);

    assert.equal(server.of(NOTE).length, 2);
    assert.equal(server.memories.has(oldId), true, "the old memory is not deleted unconfirmed");
    assert.deepEqual(store.notes[NOTE].staleMemoryIds, [oldId]);
    assert.ok(notices().some((m) => m.includes("previous version is still in GoodMem")));
    manager.dispose();
  });

  test("a memory written by 0.2.0 under the path-derived id is replaced, not duplicated", async () => {
    const { manager, store } = setup();
    const legacyId = uuidv5(`obsidian:vault:${NOTE}`, "6d329a2c-0a8e-45d1-bf5e-9f28c07d5b7c");
    server.memories.set(legacyId, {
      memoryId: legacyId, content: rev(0), path: NOTE, createdAt: 0, final: "COMPLETED"
    });

    await manager.syncNow(NOTE);

    const left = server.of(NOTE);
    assert.deepEqual(left.map((m) => m.content), [rev(1)]);
    assert.equal(server.memories.has(legacyId), false, "the 0.2.0 memory is deleted");
    assert.deepEqual(store.notes[NOTE], { memoryId: left[0].memoryId });
    manager.dispose();
  });

  test("a note never synced before is created without deleting anything", async () => {
    const { manager, store } = setup();

    await manager.syncNow(NOTE);

    // One lookup for a memory 0.2.0 might have written, then the create.
    assert.deepEqual(server.requests(), ["GET /v1/memories/{id}", "POST /v1/memories"]);
    assert.equal(store.notes[NOTE].memoryId, server.of(NOTE)[0].memoryId);
    assert.ok(store.saves > 0, "the record is saved");
    manager.dispose();
  });
});
