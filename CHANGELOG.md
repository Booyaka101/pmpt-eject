# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-08-06

First release, 116 days before `v1/prompts` is deleted.

### Added

- **`pmpt-eject capture`** — attaches to a Chrome that is already running and already
  signed in (`--remote-debugging-port=9222`) over the raw DevTools Protocol. Enables the
  network domain and pulls the body of every response Chrome reports, keeping anything
  that parses as JSON and mentions `pmpt_`. No OpenAI endpoint path is hardcoded — those
  routes are undocumented and unstable, so route sniffing is the design. Never drives a
  login, never stores a credential.
  - Live counter, flushed to disk on Ctrl-C or when the tab closes.
  - Base64 response bodies decoded transparently.
  - Bodies that are not readable at `responseReceived` time are retried once on
    `loadingFinished`.
  - Binary mime types are skipped without a round-trip.
  - `--record <file>` writes the raw CDP transcript for offline replay.
  - `--match` / `--target` / `--port` / `--out`.
- **`pmpt-eject scan [dir]`** — walks the tree (skipping `node_modules`, `.git`, `dist`
  and your own store), reports every `pmpt_` id with `file:line:column` hits and a
  `CAPTURED` / `STRANDED` badge. `--strict` exits 1 while anything is stranded, which is
  the CI gate. `--json` for machines.
- **`pmpt-eject doctor [dir]`** — days remaining until 2026-11-30, the primary sources,
  a store summary and a scan verdict.
- **`createPromptResolver({ source, ttlMs })`** — the package main. Reads a local
  directory, a `file://` URL or any `https://` base serving `index.json`.
  `expand({ id, version, variables })` returns `{ instructions, input, model }` ready to
  spread into `client.responses.create()`.
  - Stale-while-revalidate: a stale copy is served immediately while a refresh runs in
    the background, so an edit pushed to a git repo reaches a running process within
    `ttlMs` with no redeploy. A failed refresh warns, keeps serving stale, and backs off.
  - `{{name}}` substitution; unknown placeholders are left in place and reported on the
    non-enumerable `unresolved` property, so spreading or serialising the result still
    sends only `instructions` / `input` / `model`.
  - Omitted `version` resolves to the highest numeric version.
  - Named errors: `PromptNotFoundError`, `PromptVersionNotFoundError`,
    `SourceUnavailableError`, `InvalidStoreError`.
- **On-disk format v1** — `prompts/index.json` plus one 2-space-JSON file per prompt.
  Human-readable, diffable, committable. Re-capturing merges by id + version and never
  clobbers a version already on disk: a differing body is written to
  `<name>.<id>.conflict.json` with a warning.
- 105 tests (`npm test`), fully offline, run against two real recorded CDP transcripts.

[1.0.0]: https://github.com/Booyaka101/pmpt-eject/releases/tag/v1.0.0
