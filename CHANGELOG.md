# Changelog

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

### Unchanged, and why

Sync still deletes and re-creates a memory on every save. GoodMem has no update
endpoint — `PUT` and `PATCH` on `/v1/memories/{id}` both return 404, and
re-creating an existing id returns 409 — so delete-then-create is the only way
to replace a note's content. Verified against a live server (v1.0.320).

## 0.1.0

Initial release.
