#!/usr/bin/env node
/**
 * End-to-end smoke run of the published CLI against a REAL Chrome over a REAL
 * DevTools connection. Build tool; not published.
 *
 *   node scripts/live-demo.mjs
 *
 * Serves prompt-shaped JSON from a local origin, opens it in the operator's
 * already-running Chrome, spawns `bin/pmpt-eject.mjs capture` pointed at that
 * tab, lets it sniff, then closes the tab so capture flushes and exits.
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { CdpSession } from '../src/cdp.mjs'

const CDP_PORT = 9222
const OUT = 'tmp/live-demo-prompts'

const PROMPTS = {
  '/api/v0/prompts': {
    object: 'list',
    has_more: false,
    data: [
      { object: 'prompt', id: 'pmpt_livedemo', name: 'live-demo', latest_version: '2' },
      { object: 'prompt', id: 'pmpt_liveother', name: 'weekly-digest', latest_version: '1' },
    ],
  },
  '/api/v0/prompt/pmpt_livedemo': {
    object: 'prompt',
    id: 'pmpt_livedemo',
    name: 'live-demo',
    latest_version: '2',
    versions: [
      { version: '1', model: 'gpt-5.5-mini', instructions: 'Answer briefly.', messages: [{ role: 'user', content: '{{question}}' }], variables: [] },
      { version: '2', model: 'gpt-5.6-terra', instructions: 'Answer briefly, for {{customer_name}}.', messages: [{ role: 'user', content: '{{question}}' }], variables: ['customer_name'] },
    ],
  },
  '/api/v0/prompt/pmpt_liveother': {
    object: 'prompt',
    id: 'pmpt_liveother',
    name: 'weekly-digest',
    latest_version: '1',
    versions: [{ version: '1', model: 'gpt-5.6-terra', instructions: 'Summarise the week.', messages: [{ role: 'user', content: '{{items}}' }], variables: [] }],
  },
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>prompts</title><body><pre id=o>loading…</pre><script>
const r = ${JSON.stringify(Object.keys(PROMPTS))}
let n = 0
async function go(){ n++; for (const p of r) { try { await (await fetch(p+'?n='+n)).text() } catch(e){} }
  document.getElementById('o').textContent = 'round '+n }
go(); setInterval(go, 1500)
</script></body>`

await rm(OUT, { recursive: true, force: true })

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(PAGE)
  }
  const body = PROMPTS[url.pathname]
  if (!body) {
    res.writeHead(404, { 'content-type': 'application/json' })
    return res.end('{"error":"not found"}')
  }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const pageUrl = `http://127.0.0.1:${port}/`

const tab = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?url=about:blank`, { method: 'PUT' })).json()
const nav = new CdpSession(tab.webSocketDebuggerUrl)
await nav.open()
await nav.send('Page.enable')
await nav.send('Page.navigate', { url: pageUrl })
nav.close()

for (let i = 0; i < 40; i++) {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
  if (targets.some((t) => (t.url || '').includes(`127.0.0.1:${port}`))) break
  await new Promise((r) => setTimeout(r, 250))
}

console.log(`$ node bin/pmpt-eject.mjs capture --match 127.0.0.1:${port} --out ${OUT}\n`)
const child = spawn(process.execPath, ['bin/pmpt-eject.mjs', 'capture', '--match', `127.0.0.1:${port}`, '--out', OUT], {
  stdio: ['ignore', 'inherit', 'inherit'],
})

// Let it sniff a few rounds, then close the tab — capture flushes and exits 0.
await new Promise((r) => setTimeout(r, 9000))
await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${tab.id}`).catch(() => {})

const code = await new Promise((r) => child.on('close', r))
server.close()
console.log(`\n[capture exit code: ${code}]`)
