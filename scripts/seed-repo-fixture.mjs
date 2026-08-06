#!/usr/bin/env node
/**
 * Regenerates test/fixtures/repo/prompts/ by replaying the recorded CDP
 * transcript through the real capture path, then dropping one prompt so the
 * scan fixture has a genuine CAPTURED/STRANDED mix.
 *
 * Build tool; not published (see package.json "files").
 */
import { rm } from 'node:fs/promises'
import { readTranscript, replayTranscript, writeStore } from '../src/capture.mjs'

const CAPTURED_AT = '2026-08-06T09:12:44.000Z'
const OUT = 'test/fixtures/repo/prompts'
const KEEP = ['pmpt_abc']

const entries = await readTranscript('test/fixtures/transcripts/dashboard-json.jsonl')
const { collector } = replayTranscript(entries, { capturedAt: CAPTURED_AT })

for (const id of [...collector.store.prompts.keys()]) {
  if (!KEEP.includes(id)) collector.store.prompts.delete(id)
}

await rm(OUT, { recursive: true, force: true })
const written = await writeStore(OUT, collector.store, { capturedAt: CAPTURED_AT })
console.log(`wrote ${OUT}: ${written.files.join(', ')}`)
