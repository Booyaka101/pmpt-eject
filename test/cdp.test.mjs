import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  listTargets,
  selectTargets,
  attach,
  startChromeHint,
  CdpUnavailableError,
  NoTargetError,
  DEFAULT_MATCH,
} from '../src/cdp.mjs'

const TARGETS = [
  { id: '1', type: 'page', title: 'Prompts', url: 'https://platform.openai.com/prompts', webSocketDebuggerUrl: 'ws://x/1' },
  { id: '2', type: 'page', title: 'Playground', url: 'https://platform.openai.com/playground', webSocketDebuggerUrl: 'ws://x/2' },
  { id: '3', type: 'page', title: 'News', url: 'https://example.com', webSocketDebuggerUrl: 'ws://x/3' },
  { id: '4', type: 'service_worker', title: 'sw', url: 'https://platform.openai.com/sw.js', webSocketDebuggerUrl: 'ws://x/4' },
  { id: '5', type: 'page', title: 'no socket', url: 'https://platform.openai.com/x' },
]

const fakeFetch = (payload, { ok = true, status = 200 } = {}) =>
  async () => ({
    ok,
    status,
    json: async () => payload,
  })

describe('target discovery', () => {
  test('keeps only page targets that expose a debugger socket', async () => {
    const targets = await listTargets({ fetchImpl: fakeFetch(TARGETS) })
    assert.deepEqual(targets.map((t) => t.id), ['1', '2', '3'])
  })

  test('selectTargets narrows to the dashboard host', () => {
    assert.deepEqual(selectTargets(TARGETS, DEFAULT_MATCH).map((t) => t.id), ['1', '2', '4', '5'])
  })

  test('a refused connection becomes the one-line start-Chrome instruction', async () => {
    const boom = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:9222')
    }
    await assert.rejects(() => listTargets({ fetchImpl: boom }), (err) => {
      assert.ok(err instanceof CdpUnavailableError)
      assert.equal(err.code, 'CDP_UNAVAILABLE')
      assert.match(err.message, /Chrome is not listening on 127\.0\.0\.1:9222/)
      assert.match(err.message, /--remote-debugging-port=9222/)
      return true
    })
  })

  test('something else on the port is called out as such', async () => {
    await assert.rejects(
      () => listTargets({ fetchImpl: fakeFetch(null, { ok: false, status: 401 }) }),
      /Is something else using that port\?/,
    )
    await assert.rejects(
      () => listTargets({ fetchImpl: fakeFetch({ not: 'an array' }) }),
      /unexpected target list/,
    )
  })

  test('startChromeHint names all three platforms', () => {
    const hint = startChromeHint(9333)
    assert.match(hint, /Windows/)
    assert.match(hint, /macOS/)
    assert.match(hint, /Linux/)
    assert.match(hint, /--remote-debugging-port=9333/)
  })
})

describe('attach', () => {
  test('no matching tab is a NoTargetError that says what to open', async () => {
    await assert.rejects(
      () => attach({ fetchImpl: fakeFetch([TARGETS[2]]) }),
      (err) => {
        assert.ok(err instanceof NoTargetError)
        assert.equal(err.code, 'CDP_NO_TARGET')
        assert.match(err.message, /No open tab matching "platform\.openai\.com"/)
        assert.match(err.message, /platform\.openai\.com\/prompts/)
        assert.match(err.message, /1 other tab is open/)
        return true
      },
    )
  })

  test('several matching tabs are offered to the chooser', async () => {
    let offered = null
    const opened = []
    class FakeWebSocket {
      constructor(url) {
        opened.push(url)
        this.listeners = {}
        queueMicrotask(() => this.listeners.open?.())
      }
      addEventListener(name, cb) {
        this.listeners[name] = cb
      }
      removeEventListener() {}
      send() {}
      close() {}
    }
    const { target } = await attach({
      fetchImpl: fakeFetch(TARGETS),
      WebSocketImpl: FakeWebSocket,
      choose: async (targets) => {
        offered = targets.map((t) => t.id)
        return 1
      },
    })
    assert.deepEqual(offered, ['1', '2'])
    assert.equal(target.id, '2')
    assert.deepEqual(opened, ['ws://x/2'])
  })

  test('--target out of range is rejected with the real count', async () => {
    await assert.rejects(
      () => attach({ fetchImpl: fakeFetch(TARGETS), index: 7 }),
      /--target 7 is out of range; 2 matching tabs were found \(0-1\)/,
    )
  })
})

describe('CdpSession over a real WebSocket', () => {
  test('correlates ids, surfaces CDP errors, and records both directions', async () => {
    // Node ships a WebSocket client but no server, so the transport is driven by a
    // scripted socket replaying the exact frames Chrome sends.
    const { CdpSession } = await import('../src/cdp.mjs')
    const recorded = []
    class ScriptedSocket {
      constructor() {
        this.listeners = {}
        queueMicrotask(() => this.listeners.open?.())
      }
      addEventListener(name, cb) {
        this.listeners[name] = cb
      }
      removeEventListener(name) {
        delete this.listeners[name]
      }
      send(raw) {
        const msg = JSON.parse(raw)
        if (msg.method === 'Network.enable') {
          this.listeners.message?.({ data: JSON.stringify({ id: msg.id, result: {} }) })
          this.listeners.message?.({
            data: JSON.stringify({
              method: 'Network.responseReceived',
              params: { requestId: 'r1', response: { url: 'https://x/api', mimeType: 'application/json' } },
            }),
          })
        } else if (msg.method === 'Network.getResponseBody') {
          this.listeners.message?.({
            data: JSON.stringify({ id: msg.id, error: { code: -32000, message: 'No resource with given identifier found' } }),
          })
        }
      }
      close() {
        this.listeners.close?.({ reason: 'done' })
      }
    }

    const session = new CdpSession('ws://fake', { WebSocketImpl: ScriptedSocket, recorder: (e) => recorded.push(e) })
    await session.open()

    const events = []
    session.on('Network.responseReceived', (p) => events.push(p.requestId))
    assert.deepEqual(await session.send('Network.enable'), {})
    assert.deepEqual(events, ['r1'])

    await assert.rejects(
      () => session.send('Network.getResponseBody', { requestId: 'r1' }),
      /Network\.getResponseBody: No resource with given identifier found/,
    )

    assert.ok(recorded.some((e) => e.dir === 'out' && e.msg.method === 'Network.enable'))
    assert.ok(recorded.some((e) => e.dir === 'in' && e.msg.method === 'Network.responseReceived'))

    session.close()
    await assert.rejects(() => session.send('Network.enable'), /Session is closed/)
  })
})

describe('the discovery endpoint over real HTTP', () => {
  test('parses a live /json response', async (t) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(TARGETS))
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    t.after(() => new Promise((r) => server.close(r)))

    const targets = await listTargets({ port: server.address().port })
    assert.deepEqual(targets.map((t) => t.id), ['1', '2', '3'])
  })
})
