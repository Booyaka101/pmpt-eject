import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const BIN = path.join(root, 'bin', 'pmpt-eject.mjs')
const REPO = path.join(here, 'fixtures', 'repo')

/** Async spawn — never spawnSync, so an in-process server can still answer. */
function run(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: opts.cwd ?? root, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** A port nothing is listening on. */
async function closedPort() {
  const server = createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  await new Promise((r) => server.close(r))
  return port
}

describe('pmpt-eject --help / --version', () => {
  test('--help exits 0 and documents all three commands', async () => {
    const { code, stdout } = await run(['--help'])
    assert.equal(code, 0)
    assert.match(stdout, /pmpt-eject capture/)
    assert.match(stdout, /pmpt-eject scan/)
    assert.match(stdout, /pmpt-eject doctor/)
    assert.match(stdout, /November 30, 2026/)
    assert.match(stdout, /0 ok · 1 gate failed · 2 usage or environment error/)
  })

  test('--version prints the package version', async () => {
    const { code, stdout } = await run(['--version'])
    assert.equal(code, 0)
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/)
  })

  test('no arguments prints help and exits 2', async () => {
    const { code, stdout } = await run([])
    assert.equal(code, 2)
    assert.match(stdout, /USAGE/)
  })

  test('an unknown command exits 2 with a pointer to --help', async () => {
    const { code, stderr } = await run(['frobnicate'])
    assert.equal(code, 2)
    assert.match(stderr, /Unknown command "frobnicate"/)
    assert.doesNotMatch(stderr, /at .*\n\s+at /, 'no stack trace')
  })

  test('an unknown flag exits 2 without a stack trace', async () => {
    const { code, stderr } = await run(['scan', REPO, '--nope'])
    assert.equal(code, 2)
    assert.match(stderr, /--nope/)
    assert.doesNotMatch(stderr, /at .*\n\s+at /)
  })
})

describe('pmpt-eject scan', () => {
  test('prints the seeded ids with the right badges and exits 0', async () => {
    const { code, stdout } = await run(['scan', REPO])
    assert.equal(code, 0)
    assert.match(stdout, /CAPTURED {2}pmpt_abc/)
    assert.match(stdout, /STRANDED {2}pmpt_def/)
    assert.match(stdout, /STRANDED {2}pmpt_ghi789/)
    assert.match(stdout, /src\/support\.ts:6:20/)
    assert.match(stdout, /workers\/digest\.py:3:21/)
    assert.doesNotMatch(stdout, /pmpt_vendorshouldbeskipped/)
    assert.doesNotMatch(stdout, /pmpt_distshouldbeskipped/)
  })

  test('--strict is the CI gate: exit 1 while anything is stranded', async () => {
    const { code, stderr } = await run(['scan', REPO, '--strict'])
    assert.equal(code, 1)
    assert.match(stderr, /--strict: failing because 2 id\(s\) are stranded\./)
  })

  test('--strict exits 0 when every id is captured', async () => {
    // src/ references pmpt_abc and pmpt_def; both are in test/fixtures/prompts.
    const { code, stdout } = await run([
      'scan',
      path.join(REPO, 'src'),
      '--strict',
      '--prompts',
      path.join(here, 'fixtures', 'prompts'),
    ])
    assert.equal(code, 0)
    assert.match(stdout, /2 unique id\(s\) in \d+ file\(s\): 2 captured, 0 stranded\./)
  })

  test('--json is machine readable', async () => {
    const { code, stdout } = await run(['scan', REPO, '--json'])
    assert.equal(code, 0)
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.captured, 1)
    assert.equal(parsed.stranded, 2)
    assert.equal(parsed.results.length, 3)
  })

  test('a missing directory exits 2 with one clear line', async () => {
    const { code, stderr } = await run(['scan', path.join(REPO, 'nowhere')])
    assert.equal(code, 2)
    assert.match(stderr, /No such directory/)
    assert.doesNotMatch(stderr, /at .*\n\s+at /)
  })
})

describe('pmpt-eject doctor', () => {
  test('prints the countdown, the source and a scan summary', async () => {
    const { code, stdout } = await run(['doctor', REPO])
    assert.equal(code, 0)
    assert.match(stdout, /deadline {3}November 30, 2026/)
    assert.match(stdout, /remaining {2}(\d+ days?|PASSED)/)
    assert.match(stdout, /developers\.openai\.com\/api\/docs\/guides\/prompting\/migrate-from-prompt-object/)
    assert.match(stdout, /1 CAPTURED, 2 STRANDED/)
    assert.match(stdout, /verdict {4}NOT SAFE/)
  })

  test('says SAFE when nothing is stranded', async () => {
    const { code, stdout } = await run([
      'doctor',
      path.join(REPO, 'src'),
      '--prompts',
      path.join(here, 'fixtures', 'prompts'),
    ])
    assert.equal(code, 0)
    assert.match(stdout, /2 CAPTURED, 0 STRANDED/)
    assert.match(stdout, /verdict {4}SAFE/)
  })

  test('tells you to capture when no store exists', async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pmpt-eject-doc-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    await writeFile(path.join(dir, 'app.js'), "'pmpt_zzz'\n", 'utf8')

    const { code, stdout } = await run(['doctor', dir])
    assert.equal(code, 0)
    assert.match(stdout, /nothing has been rescued yet/)
    assert.match(stdout, /verdict {4}NOT SAFE/)
  })
})

describe('pmpt-eject capture without Chrome', () => {
  test('a closed debugging port gives the one-line fix and exits 2', async () => {
    const port = await closedPort()
    const { code, stderr } = await run(['capture', '--port', String(port)])
    assert.equal(code, 2)
    assert.match(stderr, new RegExp(`Chrome is not listening on 127\\.0\\.0\\.1:${port}`))
    assert.match(stderr, /--remote-debugging-port=/)
    assert.doesNotMatch(stderr, /at .*\n\s+at /, 'no stack trace')
  })

  test('a bad --port is rejected before anything is attempted', async () => {
    const { code, stderr } = await run(['capture', '--port', 'banana'])
    assert.equal(code, 2)
    assert.match(stderr, /--port must be a port number/)
  })
})
