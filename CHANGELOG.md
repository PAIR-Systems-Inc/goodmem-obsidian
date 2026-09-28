# Changelog

## 0.2.1

### Fixed

- **A failed re-save no longer deletes the note from GoodMem.** GoodMem has
  no update endpoint, so the plugin replaced a note by deleting its memory and
  then creating a new one, and when the create failed the note was gone.
  Reproduced live (v1.0.320) with a proxy answering `POST /v1/memories` with
  `500`: the note went from one memory to none and retrieval stopped
  returning it. The new memory is now created first, under a new random id,
  and the old one is deleted only after GoodMem has processed the new one. The
  same run now keeps the old memory, still retrievable, and reports the
  failure; `syncNow()` still rejects with it and the initial sync still counts
  it as failed.
- **A re-save no longer leaves the note unretrievable while GoodMem processes
  the new memory.** Deleting first left a gap in which retrieval found neither
  version: 8 of 14 retrieval samples during a live re-save, 2.1 s at the
  longest. After: 0 of 15.
- **An old memory whose delete fails is deleted later, not left behind.** The
  note is synced, its old memory's id is recorded under `staleMemoryIds` in
  `data.json`, a notice says so, and the note's next sync deletes it. A `404`
  on the delete counts as deleted.
- **A new memory that GoodMem fails to process no longer replaces the old
  one.** It is deleted, the old one is kept, and the sync is reported as
  failed. 0.2.0 reported success as soon as the create returned `PENDING`.
- **A notice within a minute of the previous one is shown, not dropped.**
  `NoticeLimiter` dropped it, so a second failed sync was never shown. It is
  now shown when the minute is up (live: at +59.7 s; before: not in 65 s).
  The initial sync's completion notice, with its counts, usually came within
  a minute of its start notice and was dropped the same way; it is now shown
  when that minute is up.

### Changed

- Memory ids are random UUIDv4 instead of `uuidv5(vault name + path)`. Which
  memory holds each note is kept in `data.json` under `syncedNotes`, next to
  the settings. A note synced by 0.2.0 is found under its old id on its next
  sync and replaced, not duplicated.
- A re-save now waits for GoodMem to process the new memory before deleting
  the old one: 0.9 to 3.9 s from save to done for a short note in live runs
  (0.2.0: 0.16 s), about 7 s for a 1 MB note, and at most 60 s before it
  gives up and leaves the old memory for the next sync. A note with no memory
  yet is not waited on.

### Added

- **11 tests** (33 in all), each failing on 0.2.0: create-before-delete
  against a fake GoodMem server that records whether a note ever had no
  processed memory; a failed create, a failed delete and its retry, a `404`
  on the delete, a failed and an unconfirmed processing; replacing a 0.2.0
  memory; a first sync that deletes nothing; the notice limiter; and the
  records being saved in `data.json` but kept out of the settings.

## 0.2.0

### Security

- **TLS certificates are verified.** Up to 0.1.0 the plugin passed
  `rejectUnauthorized: false` on every request to every host, so it would
  upload the full text of a note and the `x-api-key` header to any server
  presenting any certificate. Reproduced against a server whose certificate
  named `totally-different-host.example.com`: the connection succeeded and the
  key and note body were received.

  Verification is now on. A self-signed certificate can be accepted through the
  new **Allow self-signed certificate** setting (default off), which applies to
  **only the host in `serverUrl`** and shows a standing warning in the settings
  pane while enabled.

- The previous mitigation was a single `console.debug` line, and it was dead
  code in practice: `warnInsecureCert` preferred `logger.warn`, but the sync
  manager only ever supplies a logger with a `debug` method, and only when
  debug logging is enabled.

### Fixed

- **The initial sync counted failed uploads as successes.** `syncNow()` waited on
  the file's idle waiters, which resolved whether the upload worked or not, so a
  vault whose uploads all failed still reported "N ok, 0 failed". The failure now
  rejects `syncNow()` and the initial sync counts it. Four tests pin it.
- **`isDesktopOnly` is now `true`.** 0.1.0 declared `false` while importing
  Node's `http`/`https`, which Obsidian mobile does not provide, so the plugin
  advertised mobile support it could not deliver.

- **A `4xx` is no longer retried.** The `HttpError` for a non-retryable status
  was thrown inside the same `try` that catches network failures, so the
  retry branch below re-sent it `maxRetries` more times. A live run showed
  four attempts for one `400`. Found by running the plugin's own client
  against the server, not by reading the code.

### Added

- **18 tests**, where there were none. They bundle the plugin's real
  TypeScript with esbuild and run it under Node; the TLS tests stand up real
  HTTPS servers with self-signed certificates rather than mocking sockets.
  Covered: a wrong-host certificate is refused and nothing reaches the server;
  an exemption for one host does not apply to another; an exemption for exactly
  the configured host is honoured; `201`/`204`/`4xx`/`409` handling; the
  server's own error message survives; a non-retryable status is sent once
  while a `503` is retried; the API key is sent on every request; base-URL
  normalisation and memory-id encoding.
- `npm test` script.

### Documentation

- The README said a server's `4xx` message "reaches you as that rather than as
  a bare status". It does not: the console line is `Sync failed for <path>:
  HTTP 400` and the server's text is on the logged error's `responseBodyText`.
  The README now says where to find it.
- The README said Node.js 18+ was enough. `npm test` fails on Node 20 (`node
  --test` does not expand the glob there); the README now says Node 22+ for
  the tests and Node 20+ for the build, as measured.
- The server-URL normalisation rules sat under the "Desktop only" heading;
  they now follow the settings list they describe.

### Unchanged, and why

Sync still deletes and re-creates a memory on every save. GoodMem has no update
endpoint — `PUT` and `PATCH` on `/v1/memories/{id}` both return 404, and
re-creating an existing id returns 409 — so delete-then-create is the only way
to replace a note's content. Verified against a live server (v1.0.320).

## 0.1.0

Initial release.
