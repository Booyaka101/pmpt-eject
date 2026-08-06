/**
 * Find every `pmpt_` id still referenced in a source tree and tell you which ones
 * you have actually rescued.
 *
 * `scan --strict` is the CI gate: exit 1 while any id in your code has no captured
 * content, because on 2026-11-30 that call starts failing in production.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { readStore } from './capture.mjs'

export const DEFAULT_SKIP_DIRS = ['node_modules', '.git', 'dist']

/** Bigger than this and it is not hand-written source. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024

const ID_RE = /pmpt_[A-Za-z0-9_-]+/g

/** Directory does not exist / is not a directory. */
export class ScanPathError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ScanPathError'
    this.code = 'SCAN_PATH'
  }
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/**
 * Walk a tree and collect every prompt-id reference.
 *
 * @param {string} dir
 * @param {{ skipDirs?: string[], excludeDirs?: string[] }} [opts]
 * @returns {Promise<{ root:string, filesScanned:number, filesSkipped:number, hits: Map<string, Array<{file:string,line:number,column:number,text:string}>> }>}
 */
export async function scanTree(dir, opts = {}) {
  const root = path.resolve(dir)
  let info
  try {
    info = await stat(root)
  } catch (err) {
    throw new ScanPathError(
      err.code === 'ENOENT' ? `No such directory: ${root}` : `Cannot read ${root}: ${err.message}`,
    )
  }
  if (!info.isDirectory()) throw new ScanPathError(`Not a directory: ${root}`)

  const skip = new Set(opts.skipDirs ?? DEFAULT_SKIP_DIRS)
  const excluded = new Set((opts.excludeDirs ?? []).map((d) => path.resolve(d)))
  /** @type {Map<string, Array<any>>} */
  const hits = new Map()
  let filesScanned = 0
  let filesSkipped = 0

  const walk = async (current) => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      filesSkipped++
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue
        if (excluded.has(path.resolve(full))) continue
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      let st
      try {
        st = await stat(full)
      } catch {
        filesSkipped++
        continue
      }
      if (st.size > MAX_FILE_BYTES) {
        filesSkipped++
        continue
      }
      let buf
      try {
        buf = await readFile(full)
      } catch {
        filesSkipped++
        continue
      }
      if (looksBinary(buf)) {
        filesSkipped++
        continue
      }
      filesScanned++
      const text = buf.toString('utf8')
      if (!text.includes('pmpt_')) continue
      const rel = path.relative(root, full) || entry.name
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        for (const m of lines[i].matchAll(ID_RE)) {
          const id = m[0]
          if (!hits.has(id)) hits.set(id, [])
          hits.get(id).push({
            file: rel.split(path.sep).join('/'),
            line: i + 1,
            column: m.index + 1,
            text: lines[i].trim().slice(0, 160),
          })
        }
      }
    }
  }

  await walk(root)
  return { root, filesScanned, filesSkipped, hits }
}

/**
 * Cross-reference scan hits against a captured store.
 *
 * @param {string} dir tree to scan
 * @param {{ promptsDir?: string, skipDirs?: string[] }} [opts]
 */
export async function scan(dir, opts = {}) {
  const root = path.resolve(dir)
  const promptsDir = path.resolve(opts.promptsDir ?? path.join(root, 'prompts'))
  // The rescued store is output, not source — its own ids must not count as hits.
  const tree = await scanTree(root, { skipDirs: opts.skipDirs, excludeDirs: [promptsDir] })
  const store = await readStore(promptsDir)

  const results = []
  for (const [id, refs] of [...tree.hits].sort((a, b) => a[0].localeCompare(b[0]))) {
    const entry = store.prompts.get(id)
    const versions = entry ? entry.versions.size : 0
    let status = 'STRANDED'
    let note = null
    if (entry && versions > 0) status = 'CAPTURED'
    else if (entry) note = 'seen in the dashboard but no version content captured — open it in the browser and re-run capture'
    results.push({ id, status, note, versions, name: entry?.name ?? null, refs })
  }

  const stranded = results.filter((r) => r.status === 'STRANDED')
  return {
    root,
    promptsDir,
    filesScanned: tree.filesScanned,
    filesSkipped: tree.filesSkipped,
    storeExists: store.prompts.size > 0 || store.capturedAt !== null,
    storeCapturedAt: store.capturedAt,
    storePromptCount: store.prompts.size,
    results,
    stranded,
    capturedCount: results.length - stranded.length,
  }
}

/**
 * Render a scan result for a terminal.
 * @param {Awaited<ReturnType<typeof scan>>} result
 * @param {{ color?: boolean }} [opts]
 */
export function formatScan(result, opts = {}) {
  const color = opts.color ?? false
  const green = (s) => (color ? `\x1b[32m${s}\x1b[0m` : s)
  const red = (s) => (color ? `\x1b[31m${s}\x1b[0m` : s)
  const dim = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s)

  const out = []
  out.push(`scanning ${result.root}`)
  out.push(
    `prompts store: ${result.promptsDir}${result.storeExists ? ` (${result.storePromptCount} prompt(s), captured ${result.storeCapturedAt ?? 'unknown'})` : ' — none found'}`,
  )
  out.push('')
  if (!result.results.length) {
    out.push(`No pmpt_ ids found in ${result.filesScanned} scanned file(s). Nothing to rescue here.`)
    return out.join('\n')
  }
  for (const r of result.results) {
    const badge = r.status === 'CAPTURED' ? green('CAPTURED') : red('STRANDED')
    const label = r.name ? ` ${dim(`(${r.name})`)}` : ''
    const vs = r.status === 'CAPTURED' ? dim(` ${r.versions} version(s)`) : ''
    out.push(`${badge}  ${r.id}${label}${vs}`)
    if (r.note) out.push(`          ${dim(r.note)}`)
    for (const ref of r.refs) out.push(`          ${ref.file}:${ref.line}:${ref.column}`)
  }
  out.push('')
  out.push(
    `${result.results.length} unique id(s) in ${result.filesScanned} file(s): ${result.capturedCount} captured, ${result.stranded.length} stranded.`,
  )
  return out.join('\n')
}
