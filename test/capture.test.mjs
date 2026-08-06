import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  decodeBody,
  parseCandidate,
  extractPrompts,
  highestVersion,
  mergeCapture,
  writeStore,
  readStore,
  emptyStore,
  replayTranscript,
  readTranscript,
  countVersions,
  CaptureCollector,
  isBinaryMime,
  placeholdersIn,
  slugify,
} from '../src/capture.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const TRANSCRIPTS = path.join(here, 'fixtures', 'transcripts')
const CAPTURED_AT = '2026-08-06T09:12:44.000Z'

const tmp = async () => mkdtemp(path.join(tmpdir(), 'pmpt-eject-'))

describe('response filter', () => {
  test('keeps JSON that mentions a prompt id', () => {
    assert.deepEqual(parseCandidate('{"id":"pmpt_abc"}'), { id: 'pmpt_abc' })
  })

  test('rejects JSON with no pmpt_ anywhere', () => {
    assert.equal(parseCandidate('{"ok":true,"items":[1,2,3]}'), null)
  })

  test('rejects text that mentions pmpt_ but is not JSON', () => {
    assert.equal(parseCandidate('plain text mentioning pmpt_notjson, must be ignored'), null)
  })

  test('rejects a truncated JSON body', () => {
    assert.equal(parseCandidate('{"id":"pmpt_abc","versions":['), null)
  })

  test('rejects empty and non-string input', () => {
    assert.equal(parseCandidate(''), null)
    assert.equal(parseCandidate(undefined), null)
  })

  test('skips binary mime types without asking Chrome for the body', () => {
    assert.equal(isBinaryMime('image/png'), true)
    assert.equal(isBinaryMime('font/woff2'), true)
    assert.equal(isBinaryMime('application/json'), false)
    assert.equal(isBinaryMime(undefined), false)
  })
})

describe('body decoding', () => {
  test('decodes a base64 body', () => {
    assert.equal(decodeBody({ body: Buffer.from('{"id":"pmpt_x"}').toString('base64'), base64Encoded: true }), '{"id":"pmpt_x"}')
  })

  test('passes a plain body through', () => {
    assert.equal(decodeBody({ body: '{"a":1}', base64Encoded: false }), '{"a":1}')
  })

  test('handles a missing body', () => {
    assert.equal(decodeBody({}), '')
    assert.equal(decodeBody(null), '')
  })
})

describe('normalisation from a real recorded CDP transcript', () => {
  test('dashboard-json.jsonl yields exactly two prompts and four versions', async () => {
    const entries = await readTranscript(path.join(TRANSCRIPTS, 'dashboard-json.jsonl'))
    assert.ok(entries.length > 50, 'transcript should hold a real session worth of frames')

    const { collector, bodies } = replayTranscript(entries, { capturedAt: CAPTURED_AT })
    assert.ok(bodies.length > 0, 'transcript should contain response bodies')

    assert.equal(collector.promptCount, 2)
    assert.equal(collector.versionCount, 4)

    const abc = collector.store.prompts.get('pmpt_abc')
    assert.equal(abc.name, 'support-triage')
    assert.equal(abc.latest, '3')
    assert.deepEqual([...abc.versions.keys()].sort(), ['1', '2', '3'])
    assert.deepEqual(abc.versions.get('2'), {
      instructions: 'You are a support agent for {{customer_name}}.',
      messages: [{ role: 'user', content: 'Summarise the ticket.' }],
      model: 'gpt-5.6-terra',
      variables: ['customer_name'],
      capturedAt: CAPTURED_AT,
    })

    const def = collector.store.prompts.get('pmpt_def')
    assert.equal(def.name, 'release-notes')
    // declared ["changelog"] unioned with the {{product}}/{{version}} it actually uses
    assert.deepEqual(def.versions.get('1').variables, ['changelog', 'product', 'version'])
  })

  test('the transcript contained bodies the filter had to reject', async () => {
    const entries = await readTranscript(path.join(TRANSCRIPTS, 'dashboard-json.jsonl'))
    const { bodies } = replayTranscript(entries, { capturedAt: CAPTURED_AT })
    assert.ok(
      bodies.some((b) => b.text.includes('pmpt_notjson')),
      'a text/plain body mentioning pmpt_ should be present and ignored',
    )
    const { collector } = replayTranscript(entries, { capturedAt: CAPTURED_AT })
    assert.equal(collector.store.prompts.has('pmpt_notjson'), false)
  })

  test('octet-stream-base64.jsonl really is base64 on the wire and still decodes', async () => {
    const entries = await readTranscript(path.join(TRANSCRIPTS, 'octet-stream-base64.jsonl'))
    const base64Results = entries.filter((e) => e.dir === 'in' && e.msg?.result?.base64Encoded === true)
    assert.ok(base64Results.length > 0, 'Chrome should have base64-encoded the octet-stream bodies')

    const { collector } = replayTranscript(entries, { capturedAt: CAPTURED_AT })
    const b64 = collector.store.prompts.get('pmpt_b64')
    assert.ok(b64, 'the base64 body should have produced a prompt')
    assert.equal(b64.name, 'changelog-summary')
    const v2 = b64.versions.get('2')
    assert.equal(v2.instructions, 'Summarise the changelog for {{repo}} in {{tone}} tone.')
    // An explicit `instructions` field AND a leading system message: keep both.
    assert.deepEqual(v2.messages, [
      { role: 'system', content: 'Never invent entries.' },
      { role: 'user', content: '{{changelog}}' },
    ])
    assert.deepEqual(v2.variables, ['changelog', 'repo', 'tone'])
  })

  test('a leading system message is folded into instructions when there is no instructions field', () => {
    const found = extractPrompts(
      {
        id: 'pmpt_fold',
        name: 'folded',
        version: '1',
        model: 'gpt-5.6-terra',
        messages: [
          { role: 'system', content: 'Be terse.' },
          { role: 'user', content: 'Go.' },
        ],
      },
      { capturedAt: CAPTURED_AT },
    )
    const v = found.get('pmpt_fold').versions.get('1')
    assert.equal(v.instructions, 'Be terse.')
    assert.deepEqual(v.messages, [{ role: 'user', content: 'Go.' }])
  })

  test('a metadata-only list body registers the prompt with no versions', () => {
    const found = extractPrompts(
      {
        object: 'list',
        data: [{ object: 'prompt', id: 'pmpt_meta', name: 'only-metadata', latest_version: '7' }],
      },
      { capturedAt: CAPTURED_AT },
    )
    const entry = found.get('pmpt_meta')
    assert.equal(entry.name, 'only-metadata')
    assert.equal(entry.latest, '7')
    assert.equal(entry.versions.size, 0)
  })
})

describe('helpers', () => {
  test('highestVersion prefers numeric order', () => {
    assert.equal(highestVersion(['1', '2', '10']), '10')
    assert.equal(highestVersion(['a', 'c', 'b']), 'c')
    assert.equal(highestVersion([]), null)
  })

  test('placeholdersIn tolerates spaces', () => {
    assert.deepEqual(placeholdersIn('hi {{a}} and {{ b }}'), ['a', 'b'])
  })

  test('slugify falls back when a prompt has no name', () => {
    assert.equal(slugify(null), 'prompt')
    assert.equal(slugify('Support Triage!'), 'support-triage')
  })
})

describe('merge and conflict handling', () => {
  const version = (instructions) => ({
    instructions,
    messages: [{ role: 'user', content: 'hi' }],
    model: 'gpt-5.6-terra',
    variables: [],
    capturedAt: CAPTURED_AT,
  })

  const incoming = (instructions) =>
    new Map([['pmpt_m', { id: 'pmpt_m', name: 'merge-me', latest: '1', versions: new Map([['1', version(instructions)]]) }]])

  test('an identical re-capture is a no-op, not a conflict', () => {
    const store = emptyStore()
    const first = mergeCapture(store, incoming('same'))
    assert.deepEqual(first.addedVersions, [{ id: 'pmpt_m', version: '1' }])

    const second = mergeCapture(store, incoming('same'))
    assert.deepEqual(second.addedVersions, [])
    assert.deepEqual(second.conflicts, [])
    assert.equal(countVersions(store), 1)
  })

  test('a differing body for an existing version never clobbers what is on disk', () => {
    const store = emptyStore()
    mergeCapture(store, incoming('original'))
    const result = mergeCapture(store, incoming('rewritten'))

    assert.equal(result.conflicts.length, 1)
    assert.equal(result.conflicts[0].id, 'pmpt_m')
    assert.equal(result.conflicts[0].version, '1')
    assert.equal(store.prompts.get('pmpt_m').versions.get('1').instructions, 'original')
  })

  test('a conflict is written to .conflict.json and the prompt file keeps the original', async (t) => {
    const dir = await tmp()
    t.after(() => rm(dir, { recursive: true, force: true }))

    const store = emptyStore()
    mergeCapture(store, incoming('original'))
    await writeStore(dir, store, { capturedAt: CAPTURED_AT })

    const reloaded = await readStore(dir)
    const conflicts = mergeCapture(reloaded, incoming('rewritten')).conflicts
    await writeStore(dir, reloaded, { capturedAt: CAPTURED_AT, conflicts })

    const promptFile = JSON.parse(await readFile(path.join(dir, 'merge-me.pmpt_m.json'), 'utf8'))
    assert.equal(promptFile.versions['1'].instructions, 'original')

    const conflictFile = JSON.parse(await readFile(path.join(dir, 'merge-me.pmpt_m.conflict.json'), 'utf8'))
    assert.equal(conflictFile.conflicts.length, 1)
    assert.equal(conflictFile.conflicts[0].onDisk.instructions, 'original')
    assert.equal(conflictFile.conflicts[0].captured.instructions, 'rewritten')
  })
})

describe('on-disk format', () => {
  test('round-trips through writeStore/readStore with 2-space JSON', async (t) => {
    const dir = await tmp()
    t.after(() => rm(dir, { recursive: true, force: true }))

    const entries = await readTranscript(path.join(TRANSCRIPTS, 'dashboard-json.jsonl'))
    const { collector } = replayTranscript(entries, { capturedAt: CAPTURED_AT })
    await writeStore(dir, collector.store, { capturedAt: CAPTURED_AT })

    const raw = await readFile(path.join(dir, 'index.json'), 'utf8')
    assert.match(raw, /^\{\n {2}"schemaVersion": 1,\n/)
    assert.ok(raw.endsWith('\n'))

    const index = JSON.parse(raw)
    assert.equal(index.schemaVersion, 1)
    assert.equal(index.capturedAt, CAPTURED_AT)
    assert.deepEqual(
      index.prompts.map((p) => p.id).sort(),
      ['pmpt_abc', 'pmpt_def'],
    )
    assert.equal(index.prompts.find((p) => p.id === 'pmpt_abc').file, 'support-triage.pmpt_abc.json')

    const back = await readStore(dir)
    assert.equal(back.prompts.size, 2)
    assert.equal(countVersions(back), 4)
  })

  test('readStore on a directory that does not exist is empty, not an error', async () => {
    const store = await readStore(path.join(await tmp(), 'nope'))
    assert.equal(store.prompts.size, 0)
    assert.equal(store.capturedAt, null)
  })

  test('readStore reports a prompt file listed in the index but missing on disk', async (t) => {
    const dir = await tmp()
    t.after(() => rm(dir, { recursive: true, force: true }))
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'index.json'),
      JSON.stringify({ schemaVersion: 1, capturedAt: CAPTURED_AT, prompts: [{ id: 'pmpt_gone', name: 'gone', file: 'gone.pmpt_gone.json', latest: '1' }] }),
      'utf8',
    )
    const store = await readStore(dir)
    assert.deepEqual(store.missingFiles, ['gone.pmpt_gone.json'])
    assert.equal(store.prompts.get('pmpt_gone').versions.size, 0)
  })

  test('readStore rejects an index.json that is not JSON, with a readable message', async (t) => {
    const dir = await tmp()
    t.after(() => rm(dir, { recursive: true, force: true }))
    await writeFile(path.join(dir, 'index.json'), '{ not json', 'utf8')
    await assert.rejects(() => readStore(dir), /is not valid JSON/)
  })
})

describe('live counter', () => {
  test('reads exactly as documented', () => {
    const collector = new CaptureCollector({ capturedAt: CAPTURED_AT })
    assert.equal(
      collector.statusLine(),
      'captured 0 prompts / 0 versions — keep clicking through your prompts list, Ctrl-C when done',
    )
    collector.ingest(
      JSON.stringify({ id: 'pmpt_one', name: 'one', version: '1', model: 'gpt-5.6-terra', messages: [{ role: 'user', content: 'x' }] }),
    )
    assert.equal(
      collector.statusLine(),
      'captured 1 prompt / 1 version — keep clicking through your prompts list, Ctrl-C when done',
    )
  })
})
