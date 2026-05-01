# GoodMem Sync (Obsidian plugin)

Sync Markdown notes to a GoodMem server via the GoodMem REST API on every note save.

## Why use it

This plugin turns your Obsidian vault into a searchable knowledge base for AI, powered by [GoodMem](https://goodmem.ai). Once your notes are in GoodMem, you can do things like:

- **Search semantically** — find notes by meaning, not just keywords.
- **Summarize** — pull up the relevant pieces of a topic across many notes.
- **Power second-brain workflows** — ask questions about your own writing and get grounded answers.
- **Connect notes to LLMs** — give any LLM client (via the GoodMem API) live context from your vault.

These are just a few examples — anything you can build on top of the [GoodMem](https://goodmem.ai) API can now draw from your vault. You keep writing in Obsidian as usual; the plugin syncs each note in the background so retrieval stays current.

## How it works

On every `*.md` save, the plugin:

1. Computes a deterministic UUIDv5 `memoryId` for the file:
   - name = `obsidian:{vaultName}:{normalizedPath}`
   - namespace UUID is a constant baked into the plugin code
2. Deletes the existing memory (treats 404 as success).
3. Creates a new memory with:
   - `contentType: "text/markdown"`
   - `originalContent: <full markdown text>`
   - `metadata` including tags + path labels.

## Prerequisites: a GoodMem server

This plugin syncs to a GoodMem server, so you need one running before the plugin can do anything useful. GoodMem is free to use under its own license — no paid plan required to get started.

To install GoodMem locally, run:

```bash
curl -s "https://get.goodmem.ai" | bash
```

For more install options, including cloud options, see [goodmem.ai](https://goodmem.ai).

## Configuration

Settings (required):
- `serverUrl` (string): e.g. `http://localhost:8080` (may also be `http://localhost:8080/v1`)
- `apiKey` (string): sent as HTTP header `x-api-key: <apiKey>`
- `spaceId` (UUID string)

Settings (optional):
- `debounceMs` (number, default `750`)
- `enableDebugLogging` (boolean)
- `initialSyncOnStartup` (boolean, default `false`)
- `initialSyncConcurrency` (number, default `4`)

Server URL normalization:
- If you enter `http://host:8080`, requests go to `http://host:8080/v1/...`
- If you enter `http://host:8080/v1`, requests go to `http://host:8080/v1/...`

## Metadata written to GoodMem

The plugin stores source info in `metadata`:
- `metadata.source = "obsidian"`
- `metadata.vault = <vaultName>`
- `metadata.source_path = <vault-relative path>`
- `metadata.title = <filename without .md>`
- `metadata.updated_at = <ISO8601 timestamp>`
- `metadata.tags = ["tag", "foo/bar", ...]` (frontmatter `tags:` + inline `#tags`, deduped, without leading `#`)
- `metadata.path_labels = ["Folder", "Subfolder", ...]` (each folder in the file path)

## Install

This repo builds to the standard Obsidian plugin artifacts:
- `manifest.json`
- `main.js`

To install locally:
1. Build the plugin (see below).
2. Copy or symlink this folder into your vault at:
   - `<vault>/.obsidian/plugins/goodmem-sync/`
3. Reload Obsidian, then enable **GoodMem Sync** in Community Plugins.

## Build

Prereqs: Node.js 18+ recommended.

- Install deps: `npm install`
- Typecheck: `npm run typecheck`
- Build once: `npm run build`
- Dev (watch): `npm run dev`

## Security note

Obsidian stores plugin settings locally on disk. API keys are **not encrypted**. Treat your GoodMem API key like a secret:
- avoid sharing your vault/plugins settings files
- rotate/revoke keys if exposed

## Initial sync

You can run a one-time sync of all Markdown files via:
- Command palette: **GoodMem Sync: Initial sync all notes**

Or enable **Initial sync on startup** in the plugin settings.

During initial sync, progress is shown in the status bar (desktop). Normal save syncs also update the status bar with queued/syncing/idle.

## Manual sync

You can sync the currently open note via:
- Command palette: **GoodMem Sync: Sync current note now**
