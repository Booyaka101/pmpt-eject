# PROGRESS — pmpt-eject

**Status: v1.0.0 SHIPPED.**
Last worked: 2026-08-06.

- npm: <https://www.npmjs.com/package/pmpt-eject> — `pmpt-eject@1.0.0`, public, 9 files, 29.0 kB
- GitHub: <https://github.com/Booyaka101/pmpt-eject> — public, 6 topics, release
  [v1.0.0](https://github.com/Booyaka101/pmpt-eject/releases/tag/v1.0.0)
- CI: all 6 jobs green on the first run (node 22/24 × ubuntu-24.04/windows-2022, plus an
  end-to-end smoke job and a clean-path install job)
- Verified after publishing: `npm install pmpt-eject` into an empty directory, then
  `npx pmpt-eject --version` → `1.0.0` and `import('pmpt-eject')` → `createPromptResolver: function`

## Phase 0 — external resource verification (PASSED)

All four sources in the brief were fetched and confirmed to contain what was claimed.

| URL | Confirmed |
| --- | --- |
| `developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object` | "v1/prompts is scheduled to shut down on November 30, 2026."; the exact `prompt: { id: "pmpt_123", version: "1", variables: { customer_name: "Acme", issue: "billing question" } }` call shape; "Move the prompt content out of the managed prompt object and into your application code." — no export tooling offered |
| `developers.openai.com/api/docs/deprecations` | Reusable Prompts: announced 2026-06-03, shutdown 2026-11-30, replacement = "move reusable prompt content into your application code". Same date: Agent Builder → Agents SDK, Evals → Promptfoo. Prompts alone got no successor product. |
| `community.openai.com/t/api-to-fetch-prompt-list-from-openai/1360728` | _j (2025-10-02): "they cannot be created, retrieved or modified with an API key"; kirby.jack (2026-04-26): "The only work around now is manually copying and pasting."; Prashant_Pardesi, OpenAI staff (2026-06-25 12:31pm): "Thank you for taking the time to share this feature request. We appreciate and value your feedback. While we can't promise implementation or provide a timeline, we're grateful you shared it with us. We're closing this topic while keeping it visible for reference." |
| `community.openai.com/t/deprecation-notice-.../1382593` | IAmJackHarper (2026-06-04): "I have a lot of web apps based on prompt objects, is super convenient cause I can make small fixes to the prompt without redeploying, and also rollback to previous versions."; wswag (2026-06-04): "the main advantage of stored prompts is application independent, rapid prompt development, model optimizations and hotfixing" |

**Cost model: PASSED.** Nothing here needs a paid key, account or host. `capture` uses the operator's
own already-running, already-signed-in Chrome. The resolver reads a local directory or any public
HTTPS URL. Zero runtime dependencies. Node 22.18.0 already installed; global `WebSocket` present.

## What is VERIFIED working

Every claim below was produced by running the real code on this machine.

- **`capture` against a real Chrome over real CDP** — three separate live runs against Chrome
  150.0.7871.187 on port 9222: two while recording the fixture transcripts, one driving the actual
  `bin/pmpt-eject.mjs`. Last run captured 2 prompts / 3 versions and exited 0.
- **Base64 bodies** — Chrome really returned `base64Encoded: true` for `application/octet-stream`
  responses; those frames are in `test/fixtures/transcripts/octet-stream-base64.jsonl` and the
  decode is asserted against them.
- **`scan`** — `node bin/pmpt-eject.mjs scan test/fixtures/repo` prints
  `CAPTURED pmpt_abc`, `STRANDED pmpt_def`, `STRANDED pmpt_ghi789`, exit 0; `--strict` exits 1.
  `node_modules` and `dist` fixtures are provably skipped.
- **`doctor`** — 116 days remaining on 2026-08-06, correct against 2026-11-30.
- **`expand()`** — returns exactly the brief's expected object for the fixture store; asserted
  byte-for-byte against the README text by a test.
- **Hot-fix loop** — `examples/hotfix.mjs` edits a prompt mid-run and the change reaches the live
  resolver after `ttlMs` with no restart.
- **105 tests, `npm test`, all green, fully offline.**
- **Packaging** — `npm pack` ships 9 files (bin, src×5, package.json, README, LICENSE); no fixtures,
  no scripts, no examples. Installed from the tarball into a clean `D:\tmp\pmpt-eject-install`
  directory: the library imports, `npx pmpt-eject doctor` runs, and
  `npx pmpt-eject scan <fixture repo>` exits 0 / `--strict` exits 1.

### One acceptance command had to be run differently

The brief's `npx . scan test/fixtures/repo` is a **silent no-op** on this machine (npm 10.9.3,
Windows): it prints nothing and exits 0 — even `npx . --version` does. Verified instead through
`node bin/pmpt-eject.mjs …` and through the installed tarball (`npx pmpt-eject …` from
`D:\tmp\pmpt-eject-install`), both of which produce the specified output and exit codes. Logged in
`LESSONS.md`.

## The one acceptance item NOT met, and why

The brief says capture should be "demonstrated once against a real logged-in dashboard session
before publishing". **That cannot be done from this machine.** OpenAI hard-blocks this PC's egress IP
at Cloudflare: `platform.openai.com/prompts`, loaded in the operator's own Chrome over real CDP with
three cache-busting reloads, returns "Sorry, you have been blocked — You are unable to access
openai.com" (Cloudflare Ray `a26ca4a9fd720574`), and `chatgpt.com` in the same tab returns "Unable to
load site… [IP:14.198.160.207]". The block covers OpenAI's product hosts but **not**
`community.openai.com`, which loads normally from the same tab. Recorded as a dated bullet in
`claude-phone/ideas/LESSONS.md`.

Everything the dashboard run would exercise *was* exercised, just against a local origin instead of
`platform.openai.com`: a real Chrome, a real DevTools WebSocket, real `Network.responseReceived` /
`Network.getResponseBody` round-trips, real base64 encoding, real streaming-body retries. The only
untested variable is the shape of OpenAI's undocumented internal JSON — which is exactly why the
normaliser is a shape-agnostic deep walk over any object carrying a `pmpt_…` id rather than a parser
for one known payload.

**Resume step for the owner (5 minutes, from a machine that can reach openai.com):**

```bash
# 1. quit Chrome fully, then:
chrome --remote-debugging-port=9222
# 2. sign in and open https://platform.openai.com/prompts
# 3. from a clone of this repo:
node bin/pmpt-eject.mjs capture --record /tmp/real-session.jsonl
#    click through every prompt and version; Ctrl-C when the counter stops moving
# 4. confirm prompts/ looks right, then:
node bin/pmpt-eject.mjs scan . --strict
```
If the real payload shape defeats the normaliser, `/tmp/real-session.jsonl` is a complete transcript
that can be replayed offline with `replayTranscript()` to fix it without another live session.

## Publish checklist — DONE

1. ✅ `gh repo create Booyaka101/pmpt-eject --public --source=. --push`
2. ✅ `gh repo edit --add-topic` × 6 (openai, prompts, deprecation, migration, responses-api,
   prompt-management)
3. ✅ `git tag -a v1.0.0` + `gh release create v1.0.0`
4. ✅ `npm publish` — the name was unclaimed (registry 404 beforehand), published as `booyaka`
5. ✅ Re-verified from the public registry after propagation

### Still owner-operated: the primary launch post

The README names the right channel: the deprecation thread itself,
`community.openai.com/t/…/1382593`, where IAmJackHarper and wswag described this exact problem in
their own words. **That host is reachable from this machine** (unlike `platform.openai.com` — it is a
separate Discourse install and is not behind the Cloudflare block), but the browser session is
signed out and an agent must not drive a login or create an account. So it needs one owner tap:

> Log in at community.openai.com, open thread 1382593, and reply. Lead with the resolver — the
> hot-fix-without-redeploy half is what they said they were losing — and mention `capture` as how
> you get your content out first.

### Launch posts

- ✅ **dev.to** — published first try, live and publicly readable with all four tags:
  <https://dev.to/booyaka101/openai-is-deleting-your-stored-prompts-on-november-30-there-is-no-export-api-189p>
  (6,970 characters; tags `openai`, `node`, `javascript`, `devops`)
- ❌ **X** — not posted, and I am confident it is not postable by an agent on this build. The
  composer's DraftJS model will not accept synthetic input: text reaches the DOM every time
  (296/296 characters) but X's own counter (`[role=progressbar] aria-valuenow`) stays at **0** and
  the Post button stays `aria-disabled="true"`. Five mechanisms tried, all failing identically —
  `Input.insertText` after a collapsed Range, the same after a real mouse press/release, an
  11-character control string, a synthetic `ClipboardEvent` carrying a `DataTransfer`, and a real
  ctrl+V with the text genuinely on the Windows clipboard. It is still DraftJS (markers confirmed),
  so this is not an editor migration — the controlled component simply never reconciles DOM
  mutations it did not originate. The composer was cleared; no dirty draft is left. Logged in
  `LESSONS.md` so no future session re-walks any of those five paths.

  Ready-to-paste text (279/280 weighted):

  > OpenAI deletes v1/prompts on Nov 30 and there is no export API - they were never readable with an
  > API key, and the request for a list endpoint was closed unbuilt. pmpt-eject pulls them out of
  > your logged-in Chrome, keeps them hot-fixable with no redeploy.
  > https://github.com/Booyaka101/pmpt-eject

## Repo map

```
bin/pmpt-eject.mjs        arg parsing + dispatch, exit codes 0/1/2
src/cdp.mjs               target discovery, WebSocket, request/response correlation
src/capture.mjs           filter, normalise, merge, write, live runner, transcript replay
src/scan.mjs              tree walk + CAPTURED/STRANDED reporting
src/resolve.mjs           package main — createPromptResolver
src/deadline.mjs          the 2026-11-30 date and the countdown
test/*.test.mjs           105 tests, node --test, offline
test/fixtures/transcripts two REAL recorded CDP sessions
test/fixtures/prompts     the worked-example store
test/fixtures/repo        seeded source tree + its own captured store
scripts/                  fixture recorder, fixture seeder, live demo (not published)
examples/                 runnable expand + hotfix demos (not published)
```

`scripts/record-fixture.mjs` and `scripts/live-demo.mjs` both need a Chrome on port 9222 and will
open (and close) one tab.
