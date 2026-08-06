/**
 * Drives runCapture() — the whole live path: attach, Network.enable, pull bodies
 * on responseReceived, retry on loadingFinished, flush to disk on Ctrl-C.
 *
 * The CDP frames replayed here are the ones a real Chrome sends; the transport is
 * scripted so the test stays offline and deterministic.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runCapture, readStore, countVersions } from '../src/capture.mjs'

const PROMPT_BODY = JSON.stringify({
  object: 'prompt',
  id: 'pmpt_run',
  name: 'runner',
  latest_version: '2',
  versions: [
    { version: '1', model: 'gpt-5.5-mini', instructions: 'v1', messages: [{ role: 'user', content: 'go' }], variables: [] },
    { version: '2', model: 'gpt-5.6-terra', instructions: 'v2 {{who}}', messages: [{ role: 'user', content: 'go' }], variables: [] },
  ],
})

const TARGETS = [
  { id: 't', type: 'page', title: 'Prompts', url: 'https://platform.openai.com/prompts', webSocketDebuggerUrl: 'ws://fake/t' },
]

const fetchImpl = async () => ({ ok: true, status: 200, json: async () => TARGETS })

/**
 * A socket that answers Network.enable, then emits responses. `bodies` maps a
 * requestId to either a getResponseBody result or the string 'fail-once'.
 */
function makeSocket({ responses, bodies, onEnable }) {
  return class ScriptedSocket {
    constructor() {
      this.listeners = {}
      this.failed = new Set()
      queueMicrotask(() => this.listeners.open?.())
    }
    addEventListener(name, cb) {
      this.listeners[name] = cb
    }
    removeEventListener(name) {
      delete this.listeners[name]
    }
    #emit(obj) {
      this.listeners.message?.({ data: JSON.stringify(obj) })
    }
    send(raw) {
      const msg = JSON.parse(raw)
      if (msg.method === 'Network.enable') {
        this.#emit({ id: msg.id, result: {} })
        for (const r of responses) queueMicrotask(() => this.#emit(r))
        onEnable?.()
        return
      }
      if (msg.method === 'Network.getResponseBody') {
        const key = msg.params.requestId
        const entry = bodies[key]
        if (entry === 'fail-once' && !this.failed.has(key)) {
          this.failed.add(key)
          this.#emit({ id: msg.id, error: { code: -32000, message: 'No data found for resource with given identifier' } })
          return
        }
        const body = entry === 'fail-once' ? bodies[`${key}:retry`] : entry
        if (!body) {
          this.#emit({ id: msg.id, error: { code: -32000, message: 'No resource with given identifier found' } })
          return
        }
        this.#emit({ id: msg.id, result: body })
        return
      }
      this.#emit({ id: msg.id, result: {} })
    }
    close() {
      this.listeners.close?.({ reason: 'local' })
    }
  }
}

const sink = () => ({ write: () => {}, isTTY: false })

async function capture(t, { responses, bodies, out, existingRun = false }) {
  const dir = out ?? (await mkdtemp(path.join(tmpdir(), 'pmpt-eject-run-')))
  if (!out) t.after(() => rm(dir, { recursive: true, force: true }))
  const controller = new AbortController()
  const WebSocketImpl = makeSocket({
    responses,
    bodies,
    // Abort once the scripted traffic has been delivered — this is the Ctrl-C path.
    onEnable: () => setTimeout(() => controller.abort(), 60),
  })
  const result = await runCapture({
    out: dir,
    fetchImpl,
    WebSocketImpl,
    signal: controller.signal,
    stdout: sink(),
    stderr: sink(),
  })
  return { dir, result }
}

const responseReceived = (requestId, mimeType = 'application/json') => ({
  method: 'Network.responseReceived',
  params: { requestId, response: { url: `https://platform.openai.com/x/${requestId}`, mimeType } },
})

describe('runCapture', () => {
  test('pulls bodies, writes the store, and reports what it did', async (t) => {
    const { dir, result } = await capture(t, {
      responses: [responseReceived('r1')],
      bodies: { r1: { body: PROMPT_BODY, base64Encoded: false } },
    })

    assert.equal(result.prompts, 1)
    assert.equal(result.versions, 2)
    assert.equal(result.addedVersions, 2)
    assert.equal(result.conflicts, 0)
    assert.deepEqual(result.files, ['runner.pmpt_run.json'])

    const store = await readStore(dir)
    assert.equal(countVersions(store), 2)
    assert.equal(store.prompts.get('pmpt_run').versions.get('2').instructions, 'v2 {{who}}')
    assert.deepEqual(store.prompts.get('pmpt_run').versions.get('2').variables, ['who'])
  })

  test('decodes a base64 body coming off the wire', async (t) => {
    const { dir } = await capture(t, {
      responses: [responseReceived('r1', 'application/octet-stream')],
      bodies: { r1: { body: Buffer.from(PROMPT_BODY).toString('base64'), base64Encoded: true } },
    })
    const store = await readStore(dir)
    assert.equal(store.prompts.get('pmpt_run').versions.size, 2)
  })

  test('never asks Chrome for an image body', async (t) => {
    const asked = []
    const { result } = await capture(t, {
      responses: [responseReceived('img', 'image/png'), responseReceived('r1')],
      bodies: {
        get img() {
          asked.push('img')
          return null
        },
        r1: { body: PROMPT_BODY, base64Encoded: false },
      },
    })
    assert.equal(asked.length, 0)
    assert.equal(result.prompts, 1)
  })

  test('retries on loadingFinished when the body is not ready yet', async (t) => {
    const { result } = await capture(t, {
      responses: [responseReceived('r1'), { method: 'Network.loadingFinished', params: { requestId: 'r1' } }],
      bodies: { r1: 'fail-once', 'r1:retry': { body: PROMPT_BODY, base64Encoded: false } },
    })
    assert.equal(result.prompts, 1)
    assert.equal(result.versions, 2)
  })

  test('a body that never becomes readable is simply skipped', async (t) => {
    const { result } = await capture(t, {
      responses: [responseReceived('r1')],
      bodies: {},
    })
    assert.equal(result.prompts, 0)
    assert.equal(result.bodiesSeen, 0)
  })

  test('a second run merges instead of clobbering, and records conflicts', async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pmpt-eject-run2-'))
    t.after(() => rm(dir, { recursive: true, force: true }))

    await capture(t, { responses: [responseReceived('r1')], bodies: { r1: { body: PROMPT_BODY, base64Encoded: false } }, out: dir })

    const rewritten = PROMPT_BODY.replace('"v2 {{who}}"', '"v2 REWRITTEN"')
    const { result } = await capture(t, {
      responses: [responseReceived('r1')],
      bodies: { r1: { body: rewritten, base64Encoded: false } },
      out: dir,
    })

    assert.equal(result.prompts, 1)
    assert.equal(result.versions, 2)
    assert.equal(result.addedVersions, 0)
    assert.equal(result.conflicts, 1)
    assert.deepEqual(result.conflictFiles, ['runner.pmpt_run.conflict.json'])

    const onDisk = JSON.parse(await readFile(path.join(dir, 'runner.pmpt_run.json'), 'utf8'))
    assert.equal(onDisk.versions['2'].instructions, 'v2 {{who}}', 'the original must survive')

    const conflict = JSON.parse(await readFile(path.join(dir, 'runner.pmpt_run.conflict.json'), 'utf8'))
    assert.equal(conflict.conflicts[0].captured.instructions, 'v2 REWRITTEN')
  })

  test('writes a transcript when --record is used', async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pmpt-eject-rec-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const file = path.join(dir, 'session.jsonl')

    const controller = new AbortController()
    const WebSocketImpl = makeSocket({
      responses: [responseReceived('r1')],
      bodies: { r1: { body: PROMPT_BODY, base64Encoded: false } },
      onEnable: () => setTimeout(() => controller.abort(), 60),
    })
    const result = await runCapture({
      out: path.join(dir, 'prompts'),
      record: file,
      fetchImpl,
      WebSocketImpl,
      signal: controller.signal,
      stdout: sink(),
      stderr: sink(),
    })

    assert.ok(result.recorded > 0)
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(lines.some((e) => e.dir === 'out' && e.msg.method === 'Network.enable'))
    assert.ok(lines.some((e) => e.dir === 'in' && e.msg.method === 'Network.responseReceived'))
    assert.ok(lines.some((e) => e.dir === 'in' && e.msg.result?.body))
  })

  test('an already-aborted signal writes an empty store rather than hanging', async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pmpt-eject-abort-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const result = await runCapture({
      out: dir,
      fetchImpl,
      WebSocketImpl: makeSocket({ responses: [], bodies: {} }),
      signal: AbortSignal.abort(),
      stdout: sink(),
      stderr: sink(),
    })
    assert.equal(result.prompts, 0)
    const index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'))
    assert.deepEqual(index.prompts, [])
  })
})
