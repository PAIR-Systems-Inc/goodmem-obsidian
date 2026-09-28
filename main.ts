import { Plugin, TFile } from "obsidian";
import { GoodMemSyncSettingTab, DEFAULT_SETTINGS } from "./src/settings";
import { SyncManager, type GoodMemSyncSettings, type SyncedNote } from "./src/syncManager";

/** data.json: the settings, plus which memory holds each synced note. */
type PluginData = Partial<GoodMemSyncSettings> & { syncedNotes?: Record<string, SyncedNote> };

export default class GoodMemSyncPlugin extends Plugin {
  settings: GoodMemSyncSettings = { ...DEFAULT_SETTINGS };
  private syncedNotes: Record<string, SyncedNote> = {};
  private syncManager!: SyncManager;
  private statusEl?: HTMLElement;

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.statusEl = this.addStatusBarItem();
    this.statusEl.setText("GoodMem: idle");
    this.syncManager = new SyncManager(
      this.app,
      () => this.settings,
      (text) => this.statusEl?.setText(text),
      { notes: this.syncedNotes, save: () => this.saveSettings() }
    );

    this.addSettingTab(new GoodMemSyncSettingTab(this.app, this));

    this.addCommand({
      id: "goodmem-sync-initial-sync",
      name: "GoodMem Sync: Initial sync all notes",
      callback: () => {
        void this.syncManager.initialSyncAllMarkdownFiles({
          onProgress: ({ done, total, failed }) => {
            if (!this.statusEl) return;
            this.statusEl.setText(`GoodMem: syncing ${done}/${total}${failed > 0 ? ` (${failed} failed)` : ""}`);
            if (done >= total) this.statusEl.setText("GoodMem: idle");
          }
        });
      }
    });

    this.addCommand({
      id: "goodmem-sync-current-note",
      name: "GoodMem Sync: Sync current note now",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const enabled = !!file && file.extension === "md";
        if (checking) return enabled;
        if (!file) return;
        this.syncManager.syncNow(file.path).catch(() => {
          // Already reported by SyncManager (console + notice).
        });
      }
    });

    // Sync on every Markdown file save (Obsidian fires "modify" after writes).
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;
        if (file.extension !== "md") return;
        this.syncManager.queueSync(file.path);
      })
    );

    if (this.settings.initialSyncOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        void this.syncManager.initialSyncAllMarkdownFiles({
          onProgress: ({ done, total, failed }) => {
            if (!this.statusEl) return;
            this.statusEl.setText(`GoodMem: syncing ${done}/${total}${failed > 0 ? ` (${failed} failed)` : ""}`);
            if (done >= total) this.statusEl.setText("GoodMem: idle");
          }
        });
      });
    }
  }

  override onunload(): void {
    this.syncManager?.dispose();
    this.statusEl?.remove();
    this.statusEl = undefined;
  }

  async loadSettings(): Promise<void> {
    const { syncedNotes, ...loaded } = ((await this.loadData()) ?? {}) as PluginData;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    this.syncedNotes = syncedNotes ?? {};
  }

  /** Writes data.json: the settings and the synced-note records together. */
  async saveSettings(): Promise<void> {
    const data: PluginData = { ...this.settings, syncedNotes: this.syncedNotes };
    await this.saveData(data);
  }
}
