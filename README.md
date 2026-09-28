# GoodMem Sync (Obsidian plugin)

Sync Markdown notes to a GoodMem server via the GoodMem REST API on every note save.

> **Status — 0.2.0 (unreleased).** Not published to the Obsidian community
> plugin registry and no GitHub release exists; install by building from
> source (below). Desktop only. 22 tests run against the plugin's own bundled
> code; the retrieval-facing behaviour is verified against a live GoodMem
> server (v1.0.320).

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
- `allowSelfSignedCert` (boolean, default `false`) — see **TLS** below
- `debounceMs` (number, default `750`)
- `enableDebugLogging` (boolean, default `false`)
- `initialSyncOnStartup` (boolean, default `false`)
- `initialSyncConcurrency` (number, default `4`)

Server URL normalization:
- If you enter `http://host:8080`, requests go to `http://host:8080/v1/...`
- If you enter `http://host:8080/v1`, requests go to `http://host:8080/v1/...`

### TLS

Certificates are verified. The plugin uploads the full text of your notes and
sends your API key on every request, so accepting an unverified certificate
means handing both to anyone able to intercept the connection.

If your GoodMem server uses a self-signed certificate, turn on **Allow
self-signed certificate** in settings. It applies to **only the host in
`serverUrl`** — an exemption for `localhost:8080` never extends to any other
host — and the settings pane shows a standing warning while it is on.

> Versions up to 0.1.0 disabled verification for *every* host unconditionally,
> and reported it with a `console.debug` line that the plugin never surfaced.

### Requests and retries

Requests carry `x-api-key` and time out after 15s. A `429` or a `5xx` is
retried with exponential backoff and jitter; a `4xx` is **not** retried.

When a sync fails, Obsidian shows a notice (*GoodMem Sync failed for "…". Check
console for details.*) and the developer console logs
`[GoodMem] Sync failed for <path>: HTTP 400` followed by the error object. The
server's own message is not in that line: it is kept, unmodified, on the error's
`responseBodyText` property, so expand the logged error to read it (for example
`{"error":"Invalid UUID format"}`).

> Up to 0.1.0 a `4xx` was retried `maxRetries` more times: the error for a
> non-retryable status was thrown inside the same `try` that catches network
> failures. A live run showed **4 attempts for one 400**.

### Desktop only

The plugin uses Node's `https` module, which Obsidian mobile does not provide,
so `manifest.json` declares `isDesktopOnly: true`. (0.1.0 declared `false`
while importing the same Node modules.)

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

Prereqs: Node.js 20 or later to build; Node.js 22 or later to run the tests.
`npm test` hands `node --test` a glob (`test/**/*.test.mjs`), which Node 20
reads as a literal file name, so it fails there with `Could not find …`. CI
runs the current Node LTS.

### Install from source

```bash
npm ci
npm run build                     # produces main.js
```

Copy `main.js` and `manifest.json` into
`<vault>/.obsidian/plugins/goodmem-sync/`, then enable **GoodMem Sync** in
Obsidian's community-plugin settings.

### Working on it

- Install deps: `npm install`
- Typecheck: `npm run typecheck`
- Test: `npm test` (22 tests; Node 22+)
- Build once: `npm run build`
- Dev (watch): `npm run dev`

The tests bundle the plugin's real TypeScript with esbuild and run it under
Node, so they exercise the shipped code. The TLS tests stand up actual HTTPS
servers with self-signed certificates rather than mocking the socket.

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
