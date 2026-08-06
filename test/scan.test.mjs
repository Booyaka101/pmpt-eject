import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { scan, scanTree, formatScan, ScanPathError, DEFAULT_SKIP_DIRS } from '../src/scan.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(here, 'fixtures', 'repo')

describe('scanTree', () => {
  test('finds every id with file, line and column', async () => {
    const { hits, filesScanned } = await scanTree(REPO, { excludeDirs: [path.join(REPO, 'prompts')] })
    assert.ok(filesScanned >= 4)

    assert.deepEqual([...hits.keys()].sort(), ['pmpt_abc', 'pmpt_def', 'pmpt_ghi789'])

    const abc = hits.get('pmpt_abc')
    assert.deepEqual(
      abc.map((h) => `${h.file}:${h.line}:${h.column}`).sort(),
      ['README.md:3:25', 'src/support.ts:6:20'],
    )
    assert.match(abc.find((h) => h.file === 'src/support.ts').text, /prompt: \{ id: 'pmpt_abc'/)
  })

  test('skips node_modules, .git and dist by default', async () => {
    assert.deepEqual(DEFAULT_SKIP_DIRS, ['node_modules', '.git', 'dist'])
    const { hits } = await scanTree(REPO, { excludeDirs: [path.join(REPO, 'prompts')] })
    assert.equal(hits.has('pmpt_vendorshouldbeskipped'), false)
    assert.equal(hits.has('pmpt_distshouldbeskipped'), false)
  })

  test('a missing directory is a clear error, not a stack trace', async () => {
    await assert.rejects(() => scanTree(path.join(REPO, 'does-not-exist')), (err) => {
      assert.ok(err instanceof ScanPathError)
      assert.match(err.message, /No such directory/)
      return true
    })
  })

  test('a file instead of a directory is rejected clearly', async () => {
    await assert.rejects(() => scanTree(path.join(REPO, 'README.md')), /Not a directory/)
  })

  test('binary files are skipped, not decoded into garbage hits', async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pmpt-eject-bin-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    await writeFile(path.join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x70, 0x6d, 0x70, 0x74, 0x5f, 0x78]))
    await writeFile(path.join(dir, 'ok.js'), "const id = 'pmpt_real'\n", 'utf8')

    const { hits, filesSkipped } = await scanTree(dir)
    assert.deepEqual([...hits.keys()], ['pmpt_real'])
    assert.equal(filesSkipped, 1)
  })
})

describe('scan against a captured store', () => {
  test('reports CAPTURED and STRANDED correctly for the fixture repo', async () => {
    const result = await scan(REPO)
    assert.equal(result.results.length, 3)
    assert.deepEqual(
      result.results.map((r) => [r.id, r.status]),
      [
        ['pmpt_abc', 'CAPTURED'],
        ['pmpt_def', 'STRANDED'],
        ['pmpt_ghi789', 'STRANDED'],
      ],
    )
    assert.equal(result.capturedCount, 1)
    assert.equal(result.stranded.length, 2)
    assert.equal(result.results[0].versions, 3)
    assert.equal(result.results[0].name, 'support-triage')
  })

  test('the store directory itself is never counted as a source reference', async () => {
    const result = await scan(REPO)
    // support-triage.pmpt_abc.json inside prompts/ mentions pmpt_abc many times.
    assert.deepEqual(
      result.results.find((r) => r.id === 'pmpt_abc').refs.map((r) => r.file).sort(),
      ['README.md', 'src/support.ts'],
    )
  })

  test('a prompt seen in the dashboard but with no captured content is STRANDED with a hint', async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pmpt-eject-meta-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    await writeFile(path.join(dir, 'app.js'), "'pmpt_metaonly'\n", 'utf8')
    await mkdir(path.join(dir, 'prompts'), { recursive: true })
    await writeFile(
      path.join(dir, 'prompts', 'index.json'),
      JSON.stringify({ schemaVersion: 1, capturedAt: null, prompts: [{ id: 'pmpt_metaonly', name: 'meta', file: 'meta.pmpt_metaonly.json', latest: '2' }] }),
      'utf8',
    )
    await writeFile(
      path.join(dir, 'prompts', 'meta.pmpt_metaonly.json'),
      JSON.stringify({ id: 'pmpt_metaonly', name: 'meta', versions: {} }),
      'utf8',
    )

    const result = await scan(dir)
    assert.equal(result.results[0].status, 'STRANDED')
    assert.match(result.results[0].note, /no version content captured/)
  })

  test('no store at all means everything is stranded', async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pmpt-eject-nostore-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    await writeFile(path.join(dir, 'app.js'), "'pmpt_one' 'pmpt_two'\n", 'utf8')

    const result = await scan(dir)
    assert.equal(result.storeExists, false)
    assert.equal(result.stranded.length, 2)
  })

  test('a tree with no pmpt_ ids reports nothing to rescue', async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pmpt-eject-clean-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    await writeFile(path.join(dir, 'app.js'), 'console.log(1)\n', 'utf8')

    const result = await scan(dir)
    assert.deepEqual(result.results, [])
    assert.match(formatScan(result), /Nothing to rescue here/)
  })
})

describe('formatScan', () => {
  test('renders each id with its badge and every hit location', async () => {
    const text = formatScan(await scan(REPO))
    assert.match(text, /CAPTURED {2}pmpt_abc \(support-triage\) 3 version\(s\)/)
    assert.match(text, /STRANDED {2}pmpt_def/)
    assert.match(text, /src\/notes\.ts:3:38/)
    assert.match(text, /3 unique id\(s\) in \d+ file\(s\): 1 captured, 2 stranded\./)
    assert.doesNotMatch(text, /\x1b\[/, 'no colour codes unless asked')
  })

  test('emits colour when asked', async () => {
    const text = formatScan(await scan(REPO), { color: true })
    assert.match(text, /\x1b\[32mCAPTURED/)
    assert.match(text, /\x1b\[31mSTRANDED/)
  })
})
