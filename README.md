# pmpt-eject

[![npm](https://img.shields.io/npm/v/pmpt-eject)](https://www.npmjs.com/package/pmpt-eject)
[![ci](https://github.com/Booyaka101/pmpt-eject/actions/workflows/ci.yml/badge.svg)](https://github.com/Booyaka101/pmpt-eject/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/pmpt-eject)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/pmpt-eject?activeTab=dependencies)
[![license](https://img.shields.io/npm/l/pmpt-eject)](LICENSE)

> **OpenAI is deleting your stored prompts on November 30, 2026.**
> `v1/prompts` shuts down, the prompt content goes with it, and there is **no export API** —
> the sanctioned migration is copy-and-paste out of the dashboard, by hand, one version at a time.
>
> Run `npx pmpt-eject doctor` for a live countdown. As of 2026-08-06 there were **116 days** left.

`pmpt-eject` gets your prompts out through the browser session you already have open, tells you
which prompt ids in your codebase are still unrescued, and then gives you back the one thing the
managed prompt object was actually good for: **editing a prompt in production without a redeploy.**

Zero runtime dependencies. Node 22+. MIT.

---

## Why this exists

Three facts, all from OpenAI:

| Fact | Source |
| --- | --- |
| "v1/prompts is scheduled to shut down on November 30, 2026." | [migrate-from-prompt-object](https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object) |
| Announced 2026-06-03. The recommended replacement is "move reusable prompt content into your application code" — no export tool, unlike Agent Builder (→ Agents SDK) and Evals (→ Promptfoo), which were deprecated the same day with named successors. | [deprecations](https://developers.openai.com/api/docs/deprecations) |
| Prompt objects "cannot be created, retrieved or modified with an API key". The request for a list endpoint was closed unbuilt on 2026-06-25: "While we can't promise implementation or provide a timeline…" | [community thread 1360728](https://community.openai.com/t/api-to-fetch-prompt-list-from-openai/1360728) |

So there is no read path. Your prompt text exists in exactly one place you do not control, and it
has a deletion date. The only thing that *can* read it is the browser session that renders the
dashboard — which is precisely what `pmpt-eject capture` attaches to.

And the reason people are upset is not archival, it is operations:

> "I have a lot of web apps based on prompt objects, is super convenient cause I can make small
> fixes to the prompt without redeploying, and also rollback to previous versions."
> — IAmJackHarper, 2026-06-04

> "the main advantage of stored prompts is application independent, rapid prompt development,
> model optimizations and hotfixing"
> — wswag, 2026-06-04

Moving prompts "into your application code" takes that away. `createPromptResolver()` gives it back:
point it at a directory in a git repo, and an edit pushed to `main` reaches a running process inside
`ttlMs` with no restart, no redeploy, and no vendor.

---

## Install

```bash
npm install pmpt-eject
```

Or run it without installing:

```bash
npx pmpt-eject doctor
```

Requires **Node 22 or newer** (it uses the global `WebSocket` that landed in Node 22).

---

## The whole job, in four commands

### 1. `pmpt-eject doctor` — how bad is it?

```
$ npx pmpt-eject doctor .

pmpt-eject doctor

deadline   November 30, 2026 — v1/prompts shuts down
remaining  116 days
announced  2026-06-03
source     https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object
           https://developers.openai.com/api/docs/deprecations

store      none at /home/me/app/prompts
           nothing has been rescued yet — run `pmpt-eject capture`

scan       /home/me/app
           218 file(s) scanned, 3 unique pmpt_ id(s) referenced
           0 CAPTURED, 3 STRANDED
           STRANDED pmpt_abc  src/support.ts:6
           STRANDED pmpt_def  src/notes.ts:3
           STRANDED pmpt_ghi789  workers/digest.py:3

verdict    NOT SAFE — 3 id(s) in your code would break on November 30, 2026.
           Next: `pmpt-eject capture` with those prompts open in your dashboard.
```

### 2. `pmpt-eject capture` — get the content out

**Prerequisite:** start Chrome once with the DevTools port open, then sign in as you normally would.

```bash
# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
# macOS
open -a "Google Chrome" --args --remote-debugging-port=9222
# Linux
google-chrome --remote-debugging-port=9222
```

`pmpt-eject` does **not** drive your login, does **not** ask for a password, and does **not** store
any credential. It attaches to the tab you already have open and reads response bodies as they
arrive.

```
$ npx pmpt-eject capture

116 days until v1/prompts shuts down (November 30, 2026).

attached to: Prompts - OpenAI API
  https://platform.openai.com/prompts

captured 7 prompts / 19 versions — keep clicking through your prompts list, Ctrl-C when done
```

Click into each prompt, and each version you care about — the content only crosses the wire when the
dashboard renders it. The counter moves as it lands. Ctrl-C writes `prompts/` and stops.

Nothing about an OpenAI endpoint path is hardcoded. Those routes are undocumented and change without
notice, so the filter is deliberately dumb: **any** response body that parses as JSON **and** whose
raw text contains `pmpt_` is inspected for prompts. When OpenAI reshuffles its internal API, this
keeps working.

### 3. `pmpt-eject scan` — who is still stranded?

```
$ npx pmpt-eject scan .

scanning /home/me/app
prompts store: /home/me/app/prompts (1 prompt(s), captured 2026-08-06T09:12:44.000Z)

CAPTURED  pmpt_abc (support-triage) 3 version(s)
          README.md:3:25
          src/support.ts:6:20
STRANDED  pmpt_def
          src/notes.ts:3:38
STRANDED  pmpt_ghi789
          README.md:3:70
          workers/digest.py:3:21

3 unique id(s) in 4 file(s): 1 captured, 2 stranded.
```

`node_modules`, `.git` and `dist` are skipped, as is your own `prompts/` store. Add `--strict` and it
exits **1** while anything is stranded — that is the CI gate:

```yaml
# .github/workflows/prompts.yml
name: prompts
on: [push, pull_request]
jobs:
  not-stranded:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 22 }
      - run: npx pmpt-eject scan . --strict
```

### 4. `createPromptResolver()` — keep hot-fixing after the shutdown

**Before** (stops working on 2026-11-30):

```js
await client.responses.create({ prompt: { id: 'pmpt_abc', version: '2', variables: { customer_name: 'Acme' } } })
```

**After**:

```js
const prompts = createPromptResolver({ source: 'https://raw.githubusercontent.com/me/app/main/prompts' })
await client.responses.create(await prompts.expand({ id: 'pmpt_abc', version: '2', variables: { customer_name: 'Acme' } }))
```

`expand()` returns exactly what `responses.create()` wants:

```js
{
  instructions: 'You are a support agent for Acme.',
  input: [ { role: 'user', content: 'Summarise the ticket.' } ],
  model: 'gpt-5.6-terra'
}
```

Because `source` is an https URL, editing `prompts/support-triage.pmpt_abc.json` on `main` changes
what your running process sends — within `ttlMs`, with no redeploy. That is the whole point.

---

## The resolver, in detail

```js
import { createPromptResolver } from 'pmpt-eject'

const prompts = createPromptResolver({
  source: './prompts',   // a local directory, OR an https URL serving index.json
  ttlMs: 60_000,         // how stale a cached copy may be before revalidating (default 60s)
})

const args = await prompts.expand({ id: 'pmpt_abc', version: '2', variables: { customer_name: 'Acme' } })
```

| Option | Default | Meaning |
| --- | --- | --- |
| `source` | *(required)* | Local directory path, `file://` URL, or `http(s)://` base URL that serves `index.json` |
| `ttlMs` | `60000` | Age at which a cached copy is revalidated. `0` revalidates on every call. |
| `onWarning` | `console.warn` | Called when a stale copy is served, or a prompt file cannot be read |
| `timeoutMs` | `10000` | Per-request timeout for remote sources |
| `fetchImpl` | global `fetch` | Inject your own (proxies, retries, instrumentation) |
| `now` | `Date.now` | Injectable clock, for tests |

**Methods**

| Method | Returns |
| --- | --- |
| `expand({ id, version?, variables? })` | `{ instructions?, input, model? }` — spread straight into `responses.create()` |
| `list()` | `[{ id, name, latest, versions }]` |
| `ids()` | `['pmpt_abc', …]` |
| `refresh()` | Force-revalidate everything cached. Never throws. |
| `settled()` | Await any in-flight background revalidation |
| `cacheState()` | `[{ resource, ageMs, stale, lastError }]` |
| `clearCache()` | Drop everything cached |

**Version resolution.** Omit `version` and you get the highest numeric version. `version: 2` and
`version: '2'` are the same thing.

**Placeholders.** `{{name}}` and `{{ name }}` are both substituted from `variables`. An **unknown**
placeholder is left exactly as it is — a half-rendered prompt is easier to debug than a silently
blanked one — and is reported:

```js
const args = await prompts.expand({ id: 'pmpt_abc', version: '3', variables: { customer_name: 'Acme' } })
args.instructions        // 'You are a support agent for Acme. Escalate anything about {{issue}}.'
args.unresolved          // ['issue']
```

`unresolved`, `promptId` and `promptVersion` are **non-enumerable**, so `{ ...args }` and
`JSON.stringify(args)` still contain only `instructions`, `input` and `model`. Nothing extra ever
reaches OpenAI.

**Stale-while-revalidate.** A fresh cache is served with no network call. A stale cache is served
*immediately* while a refresh runs in the background — `expand()` never blocks on the network after
the first call. If that refresh fails, the stale copy keeps being served and `onWarning` fires; it
never throws, and it backs off instead of hammering a source that is down.

---

## On-disk format

Human-readable, diffable, 2-space JSON. Commit it.

```
prompts/
  index.json
  support-triage.pmpt_abc.json
```

`index.json`:

```json
{
  "schemaVersion": 1,
  "capturedAt": "2026-08-06T09:12:44.000Z",
  "prompts": [
    {
      "id": "pmpt_abc",
      "name": "support-triage",
      "file": "support-triage.pmpt_abc.json",
      "latest": "3"
    }
  ]
}
```

`support-triage.pmpt_abc.json`:

```json
{
  "id": "pmpt_abc",
  "name": "support-triage",
  "versions": {
    "2": {
      "instructions": "You are a support agent for {{customer_name}}.",
      "messages": [
        { "role": "user", "content": "Summarise the ticket." }
      ],
      "model": "gpt-5.6-terra",
      "variables": ["customer_name"],
      "capturedAt": "2026-08-06T09:12:44.000Z"
    }
  }
}
```

Editing this file *is* the hot-fix. Push it, and every process pointed at the repo picks it up within
its `ttlMs`.

---

## When things go wrong

`pmpt-eject` never hands you a stack trace for a situation it anticipated.

| Situation | What happens |
| --- | --- |
| Chrome not listening on 9222 | One-line fix instruction with the exact command for your OS, exit **2** |
| No `platform.openai.com` tab | Says so and tells you what to open, exit **2** |
| Several matching tabs | Lists them and asks; use `--target <n>` in a non-interactive shell |
| Chrome returns a base64 body | Decoded transparently |
| The same version captured twice, identically | Merged, no-op |
| The same version captured twice, **differently** | The copy on disk is **never** clobbered; the new body goes to `<name>.<id>.conflict.json` and you get a warning |
| Unknown id at resolve time | `PromptNotFoundError`, naming every id that *is* present |
| Unknown version | `PromptVersionNotFoundError`, listing the versions that exist |
| Remote source down, cache warm | Stale copy served, `onWarning` fires, **never throws** |
| Remote source down, cache cold | `SourceUnavailableError` naming the URL and the reason |
| HTTP 429 from the source | `SourceUnavailableError` that says *rate limited*, with `retry-after` if the server sent one |
| Empty `prompts/` | "run `pmpt-eject capture`", not a crash |
| Store is not valid JSON | `InvalidStoreError` naming the file |

Exit codes: **0** ok · **1** gate failed (`scan --strict` found stranded ids) · **2** usage or
environment error.

---

## Limitations

- **`capture` needs a browser that can actually load the dashboard.** It reads what your Chrome
  receives; it cannot reach anything your Chrome cannot. If `platform.openai.com` does not load for
  you (region block, corporate proxy), neither will this.
- **`capture` only sees what the dashboard fetches.** Open each prompt, and each version you want.
  A prompt you never click is a prompt that never crosses the wire. `scan` exists to tell you which
  ones you missed.
- **`capture` becomes useless on 2026-11-30**, when there is nothing left to capture.
  **The resolver does not** — it reads a store you own, on disk or over plain HTTPS, and keeps
  working indefinitely. Capture is a one-time rescue; the resolver is the replacement.
- **No writing back to OpenAI.** There is no API for it, and after the shutdown there is no target.
- **No source rewriting.** `scan` tells you where every `pmpt_` id is; changing those call sites is
  your call, not a codemod's.
- **Chrome/Chromium only** — it speaks the DevTools Protocol. Firefox and Safari do not.
- **`variables` are captured best-effort.** Declared variables are read from the payload and unioned
  with every `{{placeholder}}` actually used in the text, so the list is a superset, not a contract.

---

## Tests

```bash
npm test
```

105 tests, fully offline, run against two **real recorded CDP transcripts** in
`test/fixtures/transcripts/` — captured from an actual Chrome over an actual DevTools WebSocket,
including bodies Chrome really did base64-encode. Nothing in the suite mocks the protocol.

Two runnable examples live in the repo (not shipped in the npm tarball):

```bash
node examples/expand.mjs   # the worked example above, printing the real output
node examples/hotfix.mjs   # a prompt edited mid-run, reaching a live process
```

---

## Distribution

The single best first step: **reply in
[the deprecation thread itself](https://community.openai.com/t/deprecation-notice-prompt-objects-in-the-api-will-be-shut-down-on-november-30th-2026/1382593)**,
where IAmJackHarper and wswag have already described this exact problem in their own words, and
where everyone still searching "prompt objects shutdown" lands. Lead with the resolver — the
hot-fix-without-redeploy half is what they said they were losing — and mention `capture` as how you
get your content out first.

---

## License

MIT © Booyaka101
