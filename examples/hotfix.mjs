/**
 * The headline feature, demonstrated live: a prompt edited at the source reaches
 * a process that is already running, without a restart or a redeploy.
 *
 *   node examples/hotfix.mjs
 *
 * This copies the fixture store into a temp directory and edits it in place —
 * exactly what pushing a change to prompts/ on your main branch does when
 * `source` is a raw.githubusercontent.com URL.
 */

import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

import { createPromptResolver } from '../src/resolve.mjs'

const FIXTURE = fileURLToPath(new URL('../test/fixtures/prompts', import.meta.url))
const dir = await mkdtemp(path.join(tmpdir(), 'pmpt-eject-hotfix-'))
await cp(FIXTURE, dir, { recursive: true })

const TTL = 2000
const prompts = createPromptResolver({ source: dir, ttlMs: TTL })
const ask = async () => (await prompts.expand({ id: 'pmpt_abc', version: '2', variables: { customer_name: 'Acme' } })).instructions

console.log(`store  ${dir}`)
console.log(`ttlMs  ${TTL}\n`)

console.log(`t=0.0s  ${await ask()}`)

const file = path.join(dir, 'support-triage.pmpt_abc.json')
const body = JSON.parse(await readFile(file, 'utf8'))
body.versions['2'].instructions = 'You are a SENIOR support agent for {{customer_name}}. Apologise first.'
await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
console.log('        ── prompt edited at the source (git push) ──')

await sleep(500)
console.log(`t=0.5s  ${await ask()}   <- still inside ttlMs, cached copy served`)

await sleep(TTL)
console.log(`t=2.5s  ${await ask()}   <- stale copy served instantly, refresh started`)

await prompts.settled()
console.log(`t=2.5s  ${await ask()}   <- refresh landed, no restart`)

await rm(dir, { recursive: true, force: true })
