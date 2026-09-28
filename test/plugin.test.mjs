import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadModule, obsidian, fakeGoodMem } from "./harness.mjs";

globalThis.window ??= globalThis;

const { default: GoodMemSyncPlugin } = loadModule("main.ts");

let server;
before(async () => { server = await fakeGoodMem(); });
after(async () => { await server.close(); });

test("which memory holds each note is kept in data.json beside the settings, not in them", async () => {
  const file = Object.assign(new obsidian.TFile("note.md"), { basename: "note" });
  const app = {
    vault: {
      getName: () => "vault",
      getAbstractFileByPath: (p) => (p === file.path ? file : null),
      cachedRead: async () => "# Note",
      on: () => ({}),
    },
    workspace: { onLayoutReady() {} },
  };
  const plugin = new GoodMemSyncPlugin(app, { id: "goodmem-sync" });
  const earlier = { memoryId: "11111111-1111-4111-8111-111111111111", staleMemoryIds: ["22222222-2222-4222-8222-222222222222"] };
  plugin.data = {
    serverUrl: server.origin, apiKey: "test-key", spaceId: "00000000-0000-4000-8000-000000000000",
    debounceMs: 0, allowSelfSignedCert: true, syncedNotes: { "other.md": earlier },
  };
  await plugin.onload();
  assert.equal("syncedNotes" in plugin.settings, false, "the records are not a setting");

  await plugin.syncManager.syncNow("note.md");

  const created = server.of("note.md")[0].memoryId;
  assert.deepEqual(plugin.data.syncedNotes, { "other.md": earlier, "note.md": { memoryId: created } });
  assert.equal(plugin.data.apiKey, "test-key", "saving the records keeps the settings");

  await plugin.saveSettings(); // What the settings tab calls on every change.
  assert.deepEqual(plugin.data.syncedNotes["note.md"], { memoryId: created }, "saving a setting keeps the records");
  plugin.onunload();
});
