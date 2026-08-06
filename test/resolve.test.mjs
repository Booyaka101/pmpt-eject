import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createPromptResolver,
  substitute,
  PromptNotFoundError,
  PromptVersionNotFoundError,
  SourceUnavailableError,
  InvalidStoreError,
} from '../src/resolve.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PROMPTS = path.join(here, 'fixtures', 'prompts')

const silent = () => {}

describe('the worked example from the README', () => {
  test('expand() returns exactly what responses.create() needs', async () => {
    const prompts = createPromptResolver({ source: FIXTURE_PROMPTS, onWarning: silent })
    const expanded = await prompts.expand({
      id: 'pmpt_abc',
      version: '2',
      variables: { customer_name: 'Acme' },
    })

    assert.deepEqual(expanded, {
      instructions: 'You are a support agent for Acme.',
      input: [{ role: 'user', content: 'Summarise the ticket.' }],
      model: 'gpt-5.6-terra',
    })
  })

  test('spreading or serialising the result sends nothing extra to OpenAI', async () => {
    const prompts = createPromptResolver({ source: FIXTURE_PROMPTS, onWarning: silent })
    const expanded = await prompts.expand({ id: 'pmpt_abc', version: '2', variables: { customer_name: 'Acme' } })

    assert.deepEqual(Object.keys({ ...expanded }), ['instructions', 'input', 'model'])
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(expanded))), ['instructions', 'input', 'model'])
    // …while the diagnostics are still reachable.
    assert.deepEqual(expanded.unresolved, [])
    assert.equal(expanded.promptId, 'pmpt_abc')
    assert.equal(expanded.promptVersion, '2')
  })
})

describe('the README stays honest', () => {
  test('the before/after snippets appear in README.md verbatim', async () => {
    const readme = await readFile(path.join(here, '..', 'README.md'), 'utf8')
    const before =
      "await client.responses.create({ prompt: { id: 'pmpt_abc', version: '2', variables: { customer_name: 'Acme' } } })"
    const after = [
      "const prompts = createPromptResolver({ source: 'https://raw.githubusercontent.com/me/app/main/prompts' })",
      "await client.responses.create(await prompts.expand({ id: 'pmpt_abc', version: '2', variables: { customer_name: 'Acme' } }))",
    ].join('\n')
    assert.ok(readme.includes(before), 'README must contain the "before" call verbatim')
    assert.ok(readme.includes(after), 'README must contain the "after" call verbatim')
  })

  test('the documented expand() output is what expand() actually returns', async () => {
    const readme = await readFile(path.join(here, '..', 'README.md'), 'utf8')
    const documented = [
      '{',
      "  instructions: 'You are a support agent for Acme.',",
      "  input: [ { role: 'user', content: 'Summarise the ticket.' } ],",
      "  model: 'gpt-5.6-terra'",
      '}',
    ].join('\n')
    assert.ok(readme.includes(documented), 'README must document the real expand() output')

    const prompts = createPromptResolver({ source: FIXTURE_PROMPTS, onWarning: silent })
    const actual = await prompts.expand({ id: 'pmpt_abc', version: '2', variables: { customer_name: 'Acme' } })
    assert.deepEqual(actual, {
      instructions: 'You are a support agent for Acme.',
      input: [{ role: 'user', content: 'Summarise the ticket.' }],
      model: 'gpt-5.6-terra',
    })
  })
})

describe('variable substitution', () => {
  test('substitutes {{name}} and { { name } } alike', () => {
    assert.equal(substitute('hi {{a}} and {{ b }}', { a: '1', b: '2' }), 'hi 1 and 2')
  })

  test('coerces non-strings and treats null/undefined as empty', () => {
    assert.equal(substitute('{{n}}|{{z}}|{{u}}', { n: 42, z: null, u: undefined }), '42||')
  })

  test('leaves unknown placeholders untouched and reports them', async () => {
    const prompts = createPromptResolver({ source: FIXTURE_PROMPTS, onWarning: silent })
    const expanded = await prompts.expand({ id: 'pmpt_abc', version: '3', variables: { customer_name: 'Acme' } })

    assert.equal(expanded.instructions, 'You are a support agent for Acme. Escalate anything about {{issue}}.')
    assert.deepEqual(expanded.input, [{ role: 'user', content: 'Summarise the ticket for Acme.' }])
    assert.deepEqual(expanded.unresolved, ['issue'])
  })

  test('reports every unresolved placeholder once, sorted', async () => {
    const prompts = createPromptResolver({ source: FIXTURE_PROMPTS, onWarning: silent })
    const expanded = await prompts.expand({ id: 'pmpt_def' })
    assert.deepEqual(expanded.unresolved, ['changelog', 'product', 'version'])
  })

  test('rejects a non-object variables bag', async () => {
    const prompts = createPromptResolver({ source: FIXTURE_PROMPTS, onWarning: silent })
    await assert.rejects(() => prompts.expand({ id: 'pmpt_abc', variables: ['nope'] }), TypeError)
  })
})

describe('version resolution', () => {
  test('an omitted version resolves to the highest numeric version', async () => {
    const prompts = createPromptResolver({ source: FIXTURE_PROMPTS, onWarning: silent })
    const expanded = await prompts.expand({ id: 'pmpt_abc', variables: { customer_name: 'A', issue: 'billing' } })
    assert.equal(expanded.promptVersion, '3')
    assert.equal(expanded.instructions, 'You are a support agent for A. Escalate anything about billing.')
  })

  test('a numeric version is accepted as well as a string', async () => {
    const prompts = createPromptResolver({ source: FIXTURE_PROMPTS, onWarning: silent })
    const expanded = await prompts.expand({ id: 'pmpt_abc', version: 1 })
    assert.equal(expanded.model, 'gpt-5.5-mini')
  })

  test('list() reports every prompt and its versions', async () => {
    const prompts = createPromptResolver({ source: FIXTURE_PROMPTS, onWarning: silent })
    assert.deepEqual(await prompts.list(), [
      { id: 'pmpt_def', name: 'release-notes', latest: '1', versions: ['1'] },
      { id: 'pmpt_abc', name: 'support-triage', latest: '3', versions: ['1', '2', '3'] },
    ])
  })
})

describe('named errors', () => {
  test('PromptNotFoundError names the ids that are present', async () => {
    const prompts = createPromptResolver({ source: FIXTURE_PROMPTS, onWarning: silent })
    await assert.rejects(
      () => prompts.expand({ id: 'pmpt_missing' }),
      (err) => {
        assert.ok(err instanceof PromptNotFoundError)
        assert.equal(err.code, 'PROMPT_NOT_FOUND')
        assert.deepEqual(err.available.sort(), ['pmpt_abc', 'pmpt_def'])
        assert.match(err.message, /pmpt_abc/)
        assert.match(err.message, /pmpt_def/)
        return true
      },
    )
  })

  test('PromptVersionNotFoundError lists the versions that exist', async () => {
    const prompts = createPromptResolver({ source: FIXTURE_PROMPTS, onWarning: silent })
    await assert.rejects(
      () => prompts.expand({ id: 'pmpt_abc', version: '9' }),
      (err) => {
        assert.ok(err instanceof PromptVersionNotFoundError)
        assert.equal(err.code, 'PROMPT_VERSION_NOT_FOUND')
        assert.deepEqual(err.available, ['1', '2', '3'])
        assert.match(err.message, /Available versions: 1, 2, 3/)
        return true
      },
    )
  })

  test('expand() without an id is a TypeError, not a crash deep inside', async () => {
    const prompts = createPromptResolver({ source: FIXTURE_PROMPTS, onWarning: silent })
    await assert.rejects(() => prompts.expand({}), TypeError)
  })

  test('createPromptResolver() without a source explains what a source is', () => {
    assert.throws(() => createPromptResolver({}), /needs a source/)
    assert.throws(() => createPromptResolver({ source: FIXTURE_PROMPTS, ttlMs: -1 }), /non-negative/)
  })
})

describe('empty and broken stores', () => {
  const tmp = async () => mkdtemp(path.join(tmpdir(), 'pmpt-eject-res-'))

  test('an empty prompts/ directory gives a clear instruction, not a crash', async (t) => {
    const dir = await tmp()
    t.after(() => rm(dir, { recursive: true, force: true }))
    const prompts = createPromptResolver({ source: dir, onWarning: silent })
    await assert.rejects(
      () => prompts.expand({ id: 'pmpt_abc' }),
      (err) => {
        assert.ok(err instanceof SourceUnavailableError)
        assert.match(err.message, /No prompt store at/)
        assert.match(err.message, /pmpt-eject capture/)
        return true
      },
    )
  })

  test('an index.json with no prompts says the store is empty', async (t) => {
    const dir = await tmp()
    t.after(() => rm(dir, { recursive: true, force: true }))
    await writeFile(path.join(dir, 'index.json'), JSON.stringify({ schemaVersion: 1, capturedAt: null, prompts: [] }), 'utf8')

    const prompts = createPromptResolver({ source: dir, onWarning: silent })
    assert.deepEqual(await prompts.list(), [])
    await assert.rejects(
      () => prompts.expand({ id: 'pmpt_abc' }),
      (err) => {
        assert.ok(err instanceof PromptNotFoundError)
        assert.match(err.message, /is empty — run `pmpt-eject capture`/)
        return true
      },
    )
  })

  test('a store that is not a pmpt-eject store is named as such', async (t) => {
    const dir = await tmp()
    t.after(() => rm(dir, { recursive: true, force: true }))
    await writeFile(path.join(dir, 'index.json'), JSON.stringify({ hello: 'world' }), 'utf8')
    const prompts = createPromptResolver({ source: dir, onWarning: silent })
    await assert.rejects(() => prompts.expand({ id: 'pmpt_abc' }), InvalidStoreError)
  })

  test('malformed JSON is reported as malformed JSON', async (t) => {
    const dir = await tmp()
    t.after(() => rm(dir, { recursive: true, force: true }))
    await writeFile(path.join(dir, 'index.json'), '{ nope', 'utf8')
    const prompts = createPromptResolver({ source: dir, onWarning: silent })
    await assert.rejects(() => prompts.expand({ id: 'pmpt_abc' }), /is not valid JSON/)
  })

  test('a prompt file missing from disk is named', async (t) => {
    const dir = await tmp()
    t.after(() => rm(dir, { recursive: true, force: true }))
    await writeFile(
      path.join(dir, 'index.json'),
      JSON.stringify({ schemaVersion: 1, prompts: [{ id: 'pmpt_x', name: 'x', file: 'x.pmpt_x.json', latest: '1' }] }),
      'utf8',
    )
    const prompts = createPromptResolver({ source: dir, onWarning: silent })
    await assert.rejects(() => prompts.expand({ id: 'pmpt_x' }), /missing from/)
  })
})

/** A fixture store served over real HTTP, with mutable content. */
async function serveStore(instructions) {
  const state = {
    index: { schemaVersion: 1, capturedAt: '2026-08-06T09:12:44.000Z', prompts: [{ id: 'pmpt_hot', name: 'hotfix', file: 'hotfix.pmpt_hot.json', latest: '1' }] },
    prompt: { id: 'pmpt_hot', name: 'hotfix', versions: { 1: { instructions, messages: [], model: 'gpt-5.6-terra', variables: [], capturedAt: '2026-08-06T09:12:44.000Z' } } },
    status: 200,
    requests: 0,
    retryAfter: null,
  }
  const server = createServer((req, res) => {
    state.requests++
    if (state.status !== 200) {
      const headers = { 'content-type': 'application/json' }
      if (state.retryAfter) headers['retry-after'] = state.retryAfter
      res.writeHead(state.status, headers)
      res.end('{"error":"nope"}')
      return
    }
    const body = req.url.startsWith('/index.json') ? state.index : state.prompt
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return { state, base, close: () => new Promise((r) => server.close(r)) }
}

describe('stale-while-revalidate over a real HTTP source', () => {
  test('an edit at the source reaches a running process within ttlMs', async (t) => {
    const srv = await serveStore('version one')
    t.after(() => srv.close())

    let clock = 1_000_000
    const prompts = createPromptResolver({
      source: srv.base,
      ttlMs: 60_000,
      now: () => clock,
      onWarning: silent,
    })

    assert.equal((await prompts.expand({ id: 'pmpt_hot' })).instructions, 'version one')

    // Someone edits the prompt in git and pushes.
    srv.state.prompt.versions['1'].instructions = 'version two — hotfixed'

    // Still inside the TTL: the cached copy is served, no request made.
    const before = srv.state.requests
    assert.equal((await prompts.expand({ id: 'pmpt_hot' })).instructions, 'version one')
    assert.equal(srv.state.requests, before, 'a fresh cache must not hit the network')

    // TTL elapses. The stale copy is served immediately…
    clock += 60_001
    assert.equal((await prompts.expand({ id: 'pmpt_hot' })).instructions, 'version one')

    // …while a background revalidation runs. Once it lands, the edit is live.
    await prompts.settled()
    assert.equal((await prompts.expand({ id: 'pmpt_hot' })).instructions, 'version two — hotfixed')
  })

  test('a network failure with a warm cache serves stale and warns, never throws', async (t) => {
    const srv = await serveStore('warm')
    t.after(() => srv.close())

    let clock = 2_000_000
    const warnings = []
    const prompts = createPromptResolver({
      source: srv.base,
      ttlMs: 1000,
      now: () => clock,
      onWarning: (m) => warnings.push(m),
    })

    assert.equal((await prompts.expand({ id: 'pmpt_hot' })).instructions, 'warm')

    srv.state.status = 503
    clock += 5000
    assert.equal((await prompts.expand({ id: 'pmpt_hot' })).instructions, 'warm')
    await prompts.settled()
    assert.equal((await prompts.expand({ id: 'pmpt_hot' })).instructions, 'warm')

    assert.ok(warnings.some((w) => /serving a stale copy/.test(w)), `expected a stale warning, got ${JSON.stringify(warnings)}`)
    assert.ok(warnings.some((w) => /HTTP 503/.test(w)))
  })

  test('a rate limit says so, and the retry-after when the server sends one', async (t) => {
    const srv = await serveStore('rate')
    t.after(() => srv.close())
    srv.state.status = 429
    srv.state.retryAfter = '30'

    const prompts = createPromptResolver({ source: srv.base, onWarning: silent })
    await assert.rejects(
      () => prompts.expand({ id: 'pmpt_hot' }),
      (err) => {
        assert.ok(err instanceof SourceUnavailableError)
        assert.equal(err.status, 429)
        assert.match(err.message, /Rate limited \(HTTP 429\)/)
        assert.match(err.message, /retry after 30s/)
        return true
      },
    )
  })

  test('a failed revalidation backs off instead of hammering the source', async (t) => {
    const srv = await serveStore('backoff')
    t.after(() => srv.close())

    let clock = 3_000_000
    const prompts = createPromptResolver({ source: srv.base, ttlMs: 1000, now: () => clock, onWarning: silent })
    await prompts.expand({ id: 'pmpt_hot' })

    srv.state.status = 500
    clock += 2000
    await prompts.expand({ id: 'pmpt_hot' })
    await prompts.settled()
    const afterFirstFailure = srv.state.requests

    clock += 100
    await prompts.expand({ id: 'pmpt_hot' })
    await prompts.settled()
    assert.equal(srv.state.requests, afterFirstFailure, 'inside the backoff window, no new request')

    srv.state.status = 200
    srv.state.prompt.versions['1'].instructions = 'recovered'
    clock += 1000
    await prompts.expand({ id: 'pmpt_hot' })
    await prompts.settled()
    assert.equal((await prompts.expand({ id: 'pmpt_hot' })).instructions, 'recovered')
  })

  test('a cold start against an unreachable source throws SourceUnavailableError', async (t) => {
    const srv = await serveStore('gone')
    const base = srv.base
    await srv.close()

    const prompts = createPromptResolver({ source: base, onWarning: silent, timeoutMs: 2000 })
    await assert.rejects(
      () => prompts.expand({ id: 'pmpt_hot' }),
      (err) => {
        assert.ok(err instanceof SourceUnavailableError)
        assert.match(err.message, /Could not fetch/)
        return true
      },
    )
  })

  test('a 404 on index.json says where index.json is expected', async (t) => {
    const srv = await serveStore('x')
    t.after(() => srv.close())
    srv.state.status = 404

    const prompts = createPromptResolver({ source: srv.base, onWarning: silent })
    await assert.rejects(() => prompts.expand({ id: 'pmpt_hot' }), /No index\.json at .*HTTP 404/)
  })

  test('cacheState and clearCache report and reset what is held', async (t) => {
    const srv = await serveStore('state')
    t.after(() => srv.close())
    let clock = 4_000_000
    const prompts = createPromptResolver({ source: srv.base, ttlMs: 500, now: () => clock, onWarning: silent })
    await prompts.expand({ id: 'pmpt_hot' })

    const state = prompts.cacheState()
    assert.deepEqual(state.map((s) => s.resource).sort(), ['hotfix.pmpt_hot.json', 'index.json'])
    assert.equal(state.every((s) => s.stale === false), true)

    clock += 5000
    assert.equal(prompts.cacheState().every((s) => s.stale === true), true)

    prompts.clearCache()
    assert.deepEqual(prompts.cacheState(), [])
  })
})

describe('local directory sources', () => {
  test('accepts a file:// URL as well as a path', async () => {
    const url = new URL('./fixtures/prompts/', import.meta.url).href
    const prompts = createPromptResolver({ source: url, onWarning: silent })
    const expanded = await prompts.expand({ id: 'pmpt_abc', version: '1' })
    assert.equal(expanded.model, 'gpt-5.5-mini')
  })

  test('a local edit is picked up after ttlMs, same as a remote one', async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pmpt-eject-local-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    await mkdir(dir, { recursive: true })
    const write = async (instructions) => {
      await writeFile(
        path.join(dir, 'index.json'),
        JSON.stringify({ schemaVersion: 1, prompts: [{ id: 'pmpt_l', name: 'l', file: 'l.pmpt_l.json', latest: '1' }] }),
        'utf8',
      )
      await writeFile(
        path.join(dir, 'l.pmpt_l.json'),
        JSON.stringify({ id: 'pmpt_l', name: 'l', versions: { 1: { instructions, messages: [], variables: [] } } }),
        'utf8',
      )
    }
    await write('before')

    let clock = 5_000_000
    const prompts = createPromptResolver({ source: dir, ttlMs: 1000, now: () => clock, onWarning: silent })
    assert.equal((await prompts.expand({ id: 'pmpt_l' })).instructions, 'before')

    await write('after')
    clock += 1001
    assert.equal((await prompts.expand({ id: 'pmpt_l' })).instructions, 'before')
    await prompts.settled()
    assert.equal((await prompts.expand({ id: 'pmpt_l' })).instructions, 'after')
  })

  test('ttlMs: 0 revalidates on every call', async (t) => {
    const srv = await serveStore('zero')
    t.after(() => srv.close())
    const prompts = createPromptResolver({ source: srv.base, ttlMs: 0, onWarning: silent })
    await prompts.expand({ id: 'pmpt_hot' })
    const after = srv.state.requests
    await prompts.expand({ id: 'pmpt_hot' })
    await prompts.settled()
    assert.ok(srv.state.requests > after, 'ttlMs: 0 should always revalidate')
  })
})
