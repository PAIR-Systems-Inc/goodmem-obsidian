import { App, PluginSettingTab, Setting } from "obsidian";
import type GoodMemSyncPlugin from "../main";
import type { GoodMemSyncSettings } from "./syncManager";

export const DEFAULT_SETTINGS: GoodMemSyncSettings = {
  serverUrl: "",
  apiKey: "",
  spaceId: "",
  debounceMs: 750,
  enableDebugLogging: false,
  initialSyncOnStartup: false,
  initialSyncConcurrency: 4
};

export class GoodMemSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: GoodMemSyncPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "GoodMem Sync" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc('Example: "http://localhost:8080" ("/v1" is optional)')
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:8080")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Sent as the x-api-key header. Stored locally by Obsidian (not encrypted).")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("gm_...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Space ID")
      .setDesc("UUID of the GoodMem space to sync into.")
      .addText((text) =>
        text
          .setPlaceholder("550e8400-e29b-41d4-a716-446655440000")
          .setValue(this.plugin.settings.spaceId)
          .onChange(async (value) => {
            this.plugin.settings.spaceId = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Debounce (ms)")
      .setDesc("Wait time after a save before syncing (per-file).")
      .addText((text) =>
        text
          .setPlaceholder("750")
          .setValue(String(this.plugin.settings.debounceMs))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.debounceMs = Number.isFinite(parsed) ? Math.max(0, parsed) : 750;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Logs request method, URL, status, and timing to the developer console.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableDebugLogging).onChange(async (value) => {
          this.plugin.settings.enableDebugLogging = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Initial sync on startup")
      .setDesc("When enabled, syncs all Markdown files in the vault when Obsidian starts.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.initialSyncOnStartup).onChange(async (value) => {
          this.plugin.settings.initialSyncOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Initial sync concurrency")
      .setDesc("How many files to sync in parallel during initial sync.")
      .addText((text) =>
        text
          .setPlaceholder("4")
          .setValue(String(this.plugin.settings.initialSyncConcurrency))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.initialSyncConcurrency = Number.isFinite(parsed) ? Math.max(1, parsed) : 4;
            await this.plugin.saveSettings();
          })
      );
  }
}
