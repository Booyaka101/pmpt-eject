#!/usr/bin/env node
/**
 * Records the CDP transcripts under test/fixtures/transcripts/.
 *
 * This is a build tool, not part of the published package (see package.json
 * "files"). It drives a REAL Chrome over a REAL DevTools connection and captures
 * a REAL protocol transcript — the only thing that is local is the server whose
 * responses Chrome fetches, because a transcript recorded against the actual
 * OpenAI dashboard would contain the operator's own prompt content.
 *
 * Usage:
 *   node scripts/record-fixture.mjs --mode json   --out test/fixtures/transcripts/dashboard-json.jsonl
 *   node scripts/record-fixture.mjs --mode base64 --out test/fixtures/transcripts/octet-stream-base64.jsonl
 *
 * Requires a Chrome already started with --remote-debugging-port=9222.
 */

import { createServer } from 'node:http'
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import path from 'node:path'
import { runCapture } from '../src/capture.mjs'
import { CdpSession } from '../src/cdp.mjs'

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'json' },
    out: { type: 'string' },
    port: { type: 'string', default: '9222' },
    seconds: { type: 'string', default: '8' },
  },
})

const OUT = values.out ?? `test/fixtures/transcripts/${values.mode}.jsonl`
const CDP_PORT = Number(values.port)
const RUN_MS = Number(values.seconds) * 1000

const SUPPORT_TRIAGE = {
  object: 'prompt',
  id: 'pmpt_abc',
  name: 'support-triage',
  latest_version: '3',
  created_at: 1754470364,
  versions: [
    {
      version: '1',
      model: 'gpt-5.5-mini',
      instructions: 'You are a support agent.',
      messages: [{ role: 'user', content: [{ type: 'input_text', text: 'Summarise the ticket.' }] }],
      variables: [],
    },
    {
      version: '2',
      model: 'gpt-5.6-terra',
      instructions: 'You are a support agent for {{customer_name}}.',
      messages: [{ role: 'user', content: [{ type: 'input_text', text: 'Summarise the ticket.' }] }],
      variables: ['customer_name'],
    },
    {
      version: '3',
      model: 'gpt-5.6-terra',
      instructions: 'You are a support agent for {{customer_name}}. Escalate anything about {{issue}}.',
      messages: [{ role: 'user', content: [{ type: 'input_text', text: 'Summarise the ticket for {{customer_name}}.' }] }],
      variables: [{ name: 'customer_name' }, { name: 'issue' }],
    },
  ],
}

const RELEASE_NOTES = {
  object: 'prompt',
  id: 'pmpt_def',
  name: 'release-notes',
  latest_version: '1',
  created_at: 1754470001,
  versions: [
    {
      version: '1',
      model: 'gpt-5.6-terra',
      instructions: 'Write terse release notes for {{product}} version {{version}}.',
      messages: [{ role: 'user', content: 'Here is the changelog:\n{{changelog}}' }],
      variables: ['changelog'],
    },
  ],
}

const PROMPT_LIST = {
  object: 'list',
  has_more: false,
  data: [
    { object: 'prompt', id: 'pmpt_abc', name: 'support-triage', latest_version: '3', created_at: 1754470364 },
    { object: 'prompt', id: 'pmpt_def', name: 'release-notes', latest_version: '1', created_at: 1754470001 },
  ],
}

const B64_PROMPT = {
  object: 'prompt',
  id: 'pmpt_b64',
  name: 'changelog-summary',
  latest_version: '2',
  versions: [
    {
      version: '2',
      model: 'gpt-5.6-terra',
      instructions: 'Summarise the changelog for {{repo}} in {{tone}} tone.',
      messages: [{ role: 'system', content: 'Never invent entries.' }, { role: 'user', content: '{{changelog}}' }],
      variables: ['repo'],
    },
  ],
}

const ROUTES =
  values.mode === 'base64'
    ? {
        // application/octet-stream makes Chrome return the body base64Encoded.
        '/api/v0/prompt/pmpt_b64': ['application/octet-stream', JSON.stringify(B64_PROMPT)],
        '/api/v0/noise': ['application/json', JSON.stringify({ ok: true, items: [1, 2, 3] })],
      }
    : {
        '/api/v0/prompts': ['application/json', JSON.stringify(PROMPT_LIST)],
        '/api/v0/prompt/pmpt_abc': ['application/json', JSON.stringify(SUPPORT_TRIAGE)],
        '/api/v0/prompt/pmpt_def': ['application/json', JSON.stringify(RELEASE_NOTES)],
        '/api/v0/noise': ['application/json', JSON.stringify({ ok: true, items: [1, 2, 3] })],
        '/api/v0/not-json': ['text/plain; charset=utf-8', 'plain text mentioning pmpt_notjson, must be ignored'],
      }

const PAGE = `<!doctype html><meta charset="utf-8"><title>pmpt-eject fixture recorder</title>
<body><pre id="log">starting…</pre><script>
const routes = ${JSON.stringify(Object.keys(ROUTES))}
let round = 0
async function go() {
  round++
  for (const r of routes) {
    try { const res = await fetch(r + '?r=' + round); await res.text() } catch (e) {}
  }
  document.getElementById('log').textContent = 'round ' + round + ' fetched ' + routes.length + ' routes'
}
go(); setInterval(go, 1200)
</script></body>`

async function main() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(PAGE)
      return
    }
    const route = ROUTES[url.pathname]
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"not found"}')
      return
    }
    res.writeHead(200, { 'content-type': route[0], 'cache-control': 'no-store' })
    res.end(route[1])
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const pageUrl = `http://127.0.0.1:${port}/`
  console.log(`fixture server on ${pageUrl}`)

  const created = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?url=${encodeURIComponent(pageUrl)}`, {
    method: 'PUT',
  })
  if (!created.ok) throw new Error(`could not open a Chrome tab: HTTP ${created.status}`)
  const tab = await created.json()
  console.log(`opened Chrome tab ${tab.id}`)

  // Chrome 150 ignores ?url= on /json/new and always opens about:blank, so drive
  // the navigation over CDP instead.
  const nav = new CdpSession(tab.webSocketDebuggerUrl)
  await nav.open()
  await nav.send('Page.enable')
  await nav.send('Page.navigate', { url: pageUrl })
  nav.close()

  // The tab needs a moment before Chrome reports its real URL in /json.
  let visible = false
  for (let i = 0; i < 40; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
    if (targets.some((t) => t.type === 'page' && typeof t.url === 'string' && t.url.includes(`127.0.0.1:${port}`))) {
      visible = true
      break
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!visible) throw new Error(`Chrome never navigated the new tab to ${pageUrl}`)

  await rm(OUT, { force: true })
  await mkdir(path.dirname(OUT), { recursive: true })
  const tmpStore = path.join('tmp', `record-${values.mode}`)
  await rm(tmpStore, { recursive: true, force: true })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RUN_MS)
  let result
  try {
    result = await runCapture({
      port: CDP_PORT,
      out: tmpStore,
      match: `127.0.0.1:${port}`,
      record: OUT,
      signal: controller.signal,
      stdout: { write: (s) => process.stdout.write(s) },
      stderr: { write: (s) => process.stdout.write(s), isTTY: false },
    })
  } finally {
    clearTimeout(timer)
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${tab.id}`).catch(() => {})
    server.close()
  }

  console.log(`\nrecorded ${result.recorded} CDP frames -> ${OUT}`)
  console.log(`captured ${result.prompts} prompt(s) / ${result.versions} version(s)`)
  await writeFile(
    path.join(path.dirname(OUT), 'README.md'),
    `# Recorded CDP transcripts\n\n` +
      `Real Chrome DevTools Protocol frames (both directions) recorded by\n` +
      `\`scripts/record-fixture.mjs\` against a real Chrome over a real WebSocket.\n\n` +
      `The HTTP responses Chrome fetched came from a local fixture server rather than\n` +
      `platform.openai.com: a transcript recorded against the live dashboard would\n` +
      `contain the operator's own prompt content, which does not belong in a public\n` +
      `repository. The protocol frames, the requestId correlation and the base64\n` +
      `body encoding are all genuinely Chrome's.\n\n` +
      `- \`dashboard-json.jsonl\` — a prompt list, two prompt detail bodies, a JSON body\n` +
      `  with no \`pmpt_\` in it, and a text/plain body that does mention \`pmpt_\`\n` +
      `  (both of which the filter must reject).\n` +
      `- \`octet-stream-base64.jsonl\` — the same shape served as\n` +
      `  \`application/octet-stream\`, which makes Chrome return \`base64Encoded: true\`.\n`,
    'utf8',
  )
}

main().catch((err) => {
  console.error(`record-fixture failed: ${err.message}`)
  process.exitCode = 1
})
