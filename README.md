# GoodMem Sync (Obsidian plugin)

Sync Markdown notes to a GoodMem server via the GoodMem REST API on every note save.

> **Status — 0.2.1 (unreleased).** Not published to the Obsidian community
> plugin registry and no GitHub release exists; install by building from
> source (below). Desktop only. 33 tests run against the plugin's own bundled
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

1. Creates a new memory for the note, under a new random `memoryId`, with:
   - `contentType: "text/markdown"`
   - `originalContent: <full markdown text>`
   - `metadata` including tags + path labels.
2. If the note already had a memory, waits until GoodMem has processed the new
   one (`processingStatus` `COMPLETED`, checked for up to 60 s), then deletes
   the old one. A `404` on that delete counts as deleted.
3. Records which memory holds the note in the plugin's `data.json`, under
   `syncedNotes`, so the next save knows which memory to replace.

GoodMem has no update endpoint, so replacing a note's content always means a
new memory plus a delete. Creating first means a failure never leaves the note
without a memory, and retrieval returns the old version until the new one is
processed, never neither:

- **The create fails:** nothing is deleted, the note keeps its previous
  memory, and the failure is reported (see **Requests and retries**).
- **GoodMem fails to process the new memory** (`FAILED`): the new memory is
  deleted, the previous one is kept, and the sync is reported as failed.
- **The old memory's delete fails**, or the new memory is not confirmed as
  processed within 60 s: the note is synced, but the old memory stays for now,
  so retrieval can return both versions. Its id is kept in `data.json` under
  the note's `staleMemoryIds`, and the note's next sync deletes it. A notice
  says so.

Waiting for processing makes a re-save slower: 0.9 to 3.9 s from save to done
for a short note in live runs against a local server, where 0.2.0 took 0.16 s,
and about 7 s for a 1 MB note. A note with no memory yet is not waited on.

> Up to 0.2.0 the plugin deleted first, under an id derived from the path
> (`uuidv5("obsidian:{vaultName}:{normalizedPath}")`). When the create then
> failed, the note was gone from GoodMem, and even a successful re-save left
> it unretrievable for about 2 s while the new memory was processed. A note
> last synced by 0.2.0 is found under that id on its next sync and replaced
> the same way.

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

When a note is synced but its old memory could not be deleted yet, the notice
is *GoodMem Sync: "…" is synced, but its previous version is still in GoodMem.
The next sync of this note removes it.* and the console logs a
`[GoodMem] Synced <path>, but 1 older memory of it could not be deleted yet`
warning with the reason.

The plugin shows at most one notice a minute. A notice that comes sooner is
held until the minute is up and then shown, with `(suppressed N)` when others
were held back in between. Every failed sync and every old memory left behind
is also logged to the console.

> Up to 0.2.0 a notice within a minute of the previous one was dropped, so a
> second failed sync was never shown.

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
- Test: `npm test` (33 tests; Node 22+)
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
