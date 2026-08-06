/**
 * Turn sniffed HTTP responses into an on-disk, diffable prompt store.
 *
 * Route sniffing is deliberate: OpenAI's dashboard endpoints are undocumented and
 * unstable, so nothing here hardcodes a path. The only filter is "the body parses
 * as JSON and its raw text contains pmpt_", after which a shape-agnostic walk
 * harvests anything that looks like a prompt or a prompt version.
 */

import { readFile, writeFile, mkdir, readdir, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { attach, CdpProtocolError, DEFAULT_MATCH, DEFAULT_PORT } from './cdp.mjs'

/** Matches a prompt id anywhere in a blob of text. */
export const PMPT_RE = /pmpt_[A-Za-z0-9_-]+/g

/** Matches a whole string that is exactly a prompt id. */
export const PMPT_EXACT = /^pmpt_[A-Za-z0-9_-]+$/

/** `{{placeholder}}` / `{{ placeholder }}`. */
export const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g

export const SCHEMA_VERSION = 1

export const INDEX_FILE = 'index.json'

const ID_KEYS = ['id', 'prompt_id', 'promptId', 'promptID']
const NAME_KEYS = ['name', 'title', 'prompt_name', 'promptName', 'display_name', 'displayName', 'slug']
const VERSION_KEYS = ['version', 'version_number', 'versionNumber', 'version_label', 'versionLabel', 'revision']
const LATEST_KEYS = ['latest_version', 'latestVersion', 'current_version', 'currentVersion', 'active_version', 'activeVersion']
const INSTRUCTION_KEYS = ['instructions', 'system', 'system_prompt', 'systemPrompt', 'system_message']
const MESSAGE_KEYS = ['messages', 'input', 'chat_messages', 'chatMessages', 'items']
const VERSION_LIST_KEYS = ['versions', 'prompt_versions', 'promptVersions', 'revisions']
const SYSTEM_ROLES = new Set(['system', 'developer'])

/** Response bodies we never bother asking Chrome for. Mime types, never paths. */
const BINARY_MIME = /^(image|font|audio|video)\//i

/**
 * @param {string} [mimeType]
 * @returns {boolean} true when the response cannot possibly be a JSON prompt body
 */
export function isBinaryMime(mimeType) {
  return typeof mimeType === 'string' && BINARY_MIME.test(mimeType)
}

/**
 * Decode a `Network.getResponseBody` result. Chrome base64-encodes any body it
 * does not consider text.
 * @param {{ body?: string, base64Encoded?: boolean }} result
 * @returns {string}
 */
export function decodeBody(result) {
  if (!result || typeof result.body !== 'string') return ''
  return result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body
}

/**
 * The whole capture filter: JSON, and mentions a prompt id.
 * @param {string} text raw response text
 * @returns {any|null} the parsed JSON, or null if this body is not a candidate
 */
export function parseCandidate(text) {
  if (typeof text !== 'string' || !text.includes('pmpt_')) return null
  const trimmed = text.trim()
  if (!trimmed || !(trimmed.startsWith('{') || trimmed.startsWith('['))) return null
  try {
    const json = JSON.parse(trimmed)
    return json && typeof json === 'object' ? json : null
  } catch {
    return null
  }
}

function firstString(node, keys) {
  for (const k of keys) {
    const v = node[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function firstVersionLabel(node) {
  for (const k of VERSION_KEYS) {
    const v = node[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return null
}

function findPromptId(node) {
  for (const k of ID_KEYS) {
    const v = node[k]
    if (typeof v === 'string' && PMPT_EXACT.test(v)) return v
  }
  return null
}

/** Flatten a message `content` that may be a string or an array of typed parts. */
function contentToString(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const p of content) {
      if (typeof p === 'string') parts.push(p)
      else if (p && typeof p === 'object') {
        if (typeof p.text === 'string') parts.push(p.text)
        else if (typeof p.content === 'string') parts.push(p.content)
        else if (typeof p.value === 'string') parts.push(p.value)
      }
    }
    return parts.join('')
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text
  return null
}

function normaliseMessages(raw) {
  if (!Array.isArray(raw)) return null
  const out = []
  for (const m of raw) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null
    const role = typeof m.role === 'string' ? m.role : null
    const content = contentToString(m.content ?? m.text ?? m.value)
    if (!role || content === null) return null
    out.push({ role, content })
  }
  return out
}

function readMessages(node) {
  for (const k of MESSAGE_KEYS) {
    if (k in node) {
      const msgs = normaliseMessages(node[k])
      if (msgs && msgs.length) return msgs
    }
  }
  return null
}

function readModel(node) {
  const v = node.model ?? node.model_id ?? node.modelId
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (v && typeof v === 'object' && typeof v.id === 'string') return v.id.trim()
  return null
}

/** Declared variables, in whatever shape the dashboard happens to use. */
function readDeclaredVariables(node) {
  const v = node.variables ?? node.input_variables ?? node.inputVariables
  const out = []
  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item === 'string' && item.trim()) out.push(item.trim())
      else if (item && typeof item === 'object') {
        const name = firstString(item, ['name', 'key', 'variable', 'id'])
        if (name) out.push(name)
      }
    }
  } else if (v && typeof v === 'object') {
    out.push(...Object.keys(v))
  }
  return out
}

/**
 * Every `{{placeholder}}` used in a piece of text.
 * @param {string} text
 * @returns {string[]}
 */
export function placeholdersIn(text) {
  if (typeof text !== 'string') return []
  const out = []
  for (const m of text.matchAll(PLACEHOLDER_RE)) out.push(m[1])
  return out
}

/** Build a version body from a node, or null when the node holds no content. */
function toVersionBody(node, capturedAt) {
  const instructions = firstString(node, INSTRUCTION_KEYS)
  let messages = readMessages(node)
  const model = readModel(node)
  if (instructions === null && messages === null && model === null) return null

  let system = instructions
  if (messages && system === null) {
    // Some payloads carry the system prompt as the leading message instead of in
    // an `instructions` field. Only fold it up when there is no explicit field —
    // if both exist, keeping the message in place loses nothing.
    const leading = []
    while (messages.length && SYSTEM_ROLES.has(messages[0].role)) leading.push(messages.shift())
    if (leading.length) system = leading.map((m) => m.content).join('\n\n')
  }
  messages ??= []

  const declared = readDeclaredVariables(node)
  const used = [
    ...placeholdersIn(system ?? ''),
    ...messages.flatMap((m) => placeholdersIn(m.content)),
  ]
  const variables = [...new Set([...declared, ...used])].sort()

  /** @type {any} */
  const body = {}
  if (system !== null) body.instructions = system
  body.messages = messages
  if (model !== null) body.model = model
  body.variables = variables
  body.capturedAt = capturedAt
  return body
}

/** Ignore container arrays that clearly are not message lists. */
function looksLikeVersionList(value) {
  return Array.isArray(value) ? value.every((v) => v && typeof v === 'object' && !Array.isArray(v)) : false
}

/**
 * Harvest every prompt and version present anywhere in a JSON body.
 *
 * @param {any} json
 * @param {{ capturedAt?: string }} [opts]
 * @returns {Map<string, { id: string, name: string|null, latest: string|null, versions: Map<string, any> }>}
 */
export function extractPrompts(json, opts = {}) {
  const capturedAt = opts.capturedAt ?? new Date().toISOString()
  /** @type {Map<string, any>} */
  const found = new Map()
  const seen = new Set()

  const record = (id) => {
    if (!found.has(id)) found.set(id, { id, name: null, latest: null, versions: new Map() })
    return found.get(id)
  }

  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)

    if (!Array.isArray(node)) {
      const id = findPromptId(node)
      if (id) {
        const entry = record(id)
        const name = firstString(node, NAME_KEYS)
        if (name && !entry.name) entry.name = name
        const latest = firstString(node, LATEST_KEYS) ?? (typeof node.latest_version === 'number' ? String(node.latest_version) : null)
        if (latest && !entry.latest) entry.latest = latest

        // Nested version lists win over the node itself.
        let handledNested = false
        for (const key of VERSION_LIST_KEYS) {
          const list = node[key]
          if (looksLikeVersionList(list)) {
            for (const v of list) {
              const label = firstVersionLabel(v) ?? firstVersionLabel(node)
              const body = toVersionBody(v, capturedAt)
              if (body && label) {
                entry.versions.set(label, body)
                handledNested = true
              }
            }
          } else if (list && typeof list === 'object' && !Array.isArray(list)) {
            for (const [label, v] of Object.entries(list)) {
              if (!v || typeof v !== 'object') continue
              const body = toVersionBody(v, capturedAt)
              if (body) {
                entry.versions.set(String(label), body)
                handledNested = true
              }
            }
          }
        }

        if (!handledNested) {
          const label = firstVersionLabel(node) ?? entry.latest
          const body = toVersionBody(node, capturedAt)
          if (body && label) entry.versions.set(label, body)
        }
      }
    }

    if (Array.isArray(node)) {
      for (const v of node) visit(v)
    } else {
      for (const v of Object.values(node)) visit(v)
    }
  }

  visit(json)

  for (const entry of found.values()) {
    if (!entry.latest && entry.versions.size) entry.latest = highestVersion([...entry.versions.keys()])
  }
  return found
}

/**
 * Highest version label: numeric order when all labels are numeric, otherwise
 * the last in natural sort order.
 * @param {string[]} labels
 * @returns {string|null}
 */
export function highestVersion(labels) {
  const list = [...labels]
  if (!list.length) return null
  const allNumeric = list.every((l) => /^\d+$/.test(l))
  if (allNumeric) return list.reduce((a, b) => (Number(b) > Number(a) ? b : a))
  return [...list].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1)
}

/** Stable key for "is this the same version body?" — ignores capturedAt. */
export function versionFingerprint(body) {
  const norm = {
    instructions: body?.instructions ?? null,
    messages: (body?.messages ?? []).map((m) => ({ role: m.role, content: m.content })),
    model: body?.model ?? null,
    variables: [...(body?.variables ?? [])].sort(),
  }
  return JSON.stringify(norm)
}

/** Filesystem-safe slug for the prompt filename. */
export function slugify(name, fallback = 'prompt') {
  const s = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return s || fallback
}

/** @param {{id:string,name?:string|null}} prompt */
export function fileNameFor(prompt) {
  return `${slugify(prompt.name)}.${prompt.id}.json`
}

/** An empty in-memory store. */
export function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, capturedAt: null, prompts: new Map() }
}

/**
 * Read an existing prompt store from disk. A missing directory is not an error —
 * it just means nothing has been captured yet.
 *
 * @param {string} dir
 * @returns {Promise<{ schemaVersion:number, capturedAt:string|null, prompts: Map<string, any>, missingFiles: string[] }>}
 */
export async function readStore(dir) {
  const store = { ...emptyStore(), missingFiles: [] }
  let indexRaw
  try {
    indexRaw = await readFile(path.join(dir, INDEX_FILE), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return store
    throw new Error(`Could not read ${path.join(dir, INDEX_FILE)}: ${err.message}`)
  }
  let index
  try {
    index = JSON.parse(indexRaw)
  } catch (err) {
    throw new Error(`${path.join(dir, INDEX_FILE)} is not valid JSON: ${err.message}`)
  }
  store.schemaVersion = index.schemaVersion ?? SCHEMA_VERSION
  store.capturedAt = index.capturedAt ?? null
  for (const meta of index.prompts ?? []) {
    if (!meta?.id) continue
    const file = meta.file ?? fileNameFor(meta)
    let body
    try {
      body = JSON.parse(await readFile(path.join(dir, file), 'utf8'))
    } catch (err) {
      if (err.code === 'ENOENT') {
        store.missingFiles.push(file)
        store.prompts.set(meta.id, { id: meta.id, name: meta.name ?? null, file, latest: meta.latest ?? null, versions: new Map() })
        continue
      }
      throw new Error(`Could not read ${path.join(dir, file)}: ${err.message}`)
    }
    const versions = new Map(Object.entries(body.versions ?? {}))
    store.prompts.set(meta.id, {
      id: meta.id,
      name: body.name ?? meta.name ?? null,
      file,
      latest: meta.latest ?? highestVersion([...versions.keys()]),
      versions,
    })
  }
  return store
}

/**
 * Merge freshly captured prompts into an existing store.
 *
 * A version already on disk is never clobbered: if the new body differs it is
 * recorded as a conflict instead, for the caller to write to `.conflict.json`.
 *
 * @param {{prompts: Map<string, any>}} store mutated in place
 * @param {Map<string, any>} incoming from {@link extractPrompts}
 * @returns {{ addedPrompts: string[], addedVersions: Array<{id:string,version:string}>, conflicts: Array<{id:string,version:string,existing:any,incoming:any}> }}
 */
export function mergeCapture(store, incoming) {
  const addedPrompts = []
  const addedVersions = []
  const conflicts = []
  for (const [id, fresh] of incoming) {
    let entry = store.prompts.get(id)
    if (!entry) {
      entry = { id, name: fresh.name ?? null, file: null, latest: null, versions: new Map() }
      store.prompts.set(id, entry)
      addedPrompts.push(id)
    }
    if (!entry.name && fresh.name) entry.name = fresh.name
    for (const [version, body] of fresh.versions) {
      const existing = entry.versions.get(version)
      if (!existing) {
        entry.versions.set(version, body)
        addedVersions.push({ id, version })
      } else if (versionFingerprint(existing) !== versionFingerprint(body)) {
        conflicts.push({ id, version, existing, incoming: body })
      }
    }
    entry.latest = highestVersion([...entry.versions.keys()]) ?? fresh.latest ?? entry.latest
    if (!entry.file) entry.file = fileNameFor(entry)
  }
  return { addedPrompts, addedVersions, conflicts }
}

const stringify = (v) => `${JSON.stringify(v, null, 2)}\n`

/**
 * Write the store to disk in the documented, diffable format.
 *
 * @param {string} dir
 * @param {{prompts: Map<string, any>}} store
 * @param {{ capturedAt?: string, conflicts?: Array<any> }} [opts]
 * @returns {Promise<{ files: string[], conflictFiles: string[] }>}
 */
export async function writeStore(dir, store, opts = {}) {
  const capturedAt = opts.capturedAt ?? new Date().toISOString()
  await mkdir(dir, { recursive: true })
  const prompts = [...store.prompts.values()].sort((a, b) =>
    (a.name ?? a.id).localeCompare(b.name ?? b.id, 'en', { numeric: true }),
  )
  const files = []
  for (const p of prompts) {
    p.file ??= fileNameFor(p)
    const versionKeys = [...p.versions.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    const versions = {}
    for (const k of versionKeys) versions[k] = p.versions.get(k)
    await writeFile(path.join(dir, p.file), stringify({ id: p.id, name: p.name ?? null, versions }), 'utf8')
    files.push(p.file)
  }
  const index = {
    schemaVersion: SCHEMA_VERSION,
    capturedAt,
    prompts: prompts.map((p) => ({
      id: p.id,
      name: p.name ?? null,
      file: p.file,
      latest: p.latest ?? highestVersion([...p.versions.keys()]),
    })),
  }
  await writeFile(path.join(dir, INDEX_FILE), stringify(index), 'utf8')

  const conflictFiles = []
  const byPrompt = new Map()
  for (const c of opts.conflicts ?? []) {
    if (!byPrompt.has(c.id)) byPrompt.set(c.id, [])
    byPrompt.get(c.id).push(c)
  }
  for (const [id, list] of byPrompt) {
    const entry = store.prompts.get(id) ?? { id, name: null }
    const file = `${slugify(entry.name)}.${id}.conflict.json`
    const existingRaw = await readFile(path.join(dir, file), 'utf8').catch(() => null)
    const prior = existingRaw ? JSON.parse(existingRaw) : { id, name: entry.name ?? null, conflicts: [] }
    prior.conflicts.push(
      ...list.map((c) => ({
        version: c.version,
        detectedAt: capturedAt,
        onDisk: c.existing,
        captured: c.incoming,
      })),
    )
    await writeFile(path.join(dir, file), stringify(prior), 'utf8')
    conflictFiles.push(file)
  }
  return { files, conflictFiles }
}

/** Total versions across a store. */
export function countVersions(store) {
  let n = 0
  for (const p of store.prompts.values()) n += p.versions.size
  return n
}

/**
 * A capture run in progress. Feed it decoded response bodies; ask it for counts.
 */
export class CaptureCollector {
  /** @param {{ store?: any, capturedAt?: string }} [opts] */
  constructor(opts = {}) {
    this.store = opts.store ?? emptyStore()
    this.capturedAt = opts.capturedAt ?? new Date().toISOString()
    this.conflicts = []
    this.bodiesSeen = 0
    this.bodiesKept = 0
  }

  /**
   * @param {string} text decoded response body
   * @param {{ url?: string }} [meta]
   * @returns {{ kept: boolean, addedPrompts: string[], addedVersions: Array<any>, conflicts: Array<any> }}
   */
  ingest(text, meta = {}) {
    this.bodiesSeen++
    const json = parseCandidate(text)
    if (!json) return { kept: false, addedPrompts: [], addedVersions: [], conflicts: [] }
    const incoming = extractPrompts(json, { capturedAt: this.capturedAt })
    if (!incoming.size) return { kept: false, addedPrompts: [], addedVersions: [], conflicts: [] }
    this.bodiesKept++
    const result = mergeCapture(this.store, incoming)
    if (result.conflicts.length) {
      for (const c of result.conflicts) this.conflicts.push({ ...c, url: meta.url ?? null })
    }
    return { kept: true, ...result }
  }

  get promptCount() {
    return this.store.prompts.size
  }

  get versionCount() {
    return countVersions(this.store)
  }

  /** The exact live-counter line. */
  statusLine() {
    const p = this.promptCount
    const v = this.versionCount
    return `captured ${p} prompt${p === 1 ? '' : 's'} / ${v} version${v === 1 ? '' : 's'} — keep clicking through your prompts list, Ctrl-C when done`
  }
}

/**
 * Replay a recorded CDP transcript (as written by `capture --record`) through the
 * exact same ingest path the live capture uses.
 *
 * @param {Array<{dir:'in'|'out', msg:any}>} entries
 * @param {{ store?: any, capturedAt?: string }} [opts]
 * @returns {{ collector: CaptureCollector, bodies: Array<{requestId:string,url:string|null,text:string}> }}
 */
export function replayTranscript(entries, opts = {}) {
  const collector = new CaptureCollector(opts)
  const urlByRequest = new Map()
  const requestByCommandId = new Map()
  const bodies = []

  for (const entry of entries) {
    const msg = entry?.msg
    if (!msg) continue
    if (entry.dir === 'in' && msg.method === 'Network.responseReceived') {
      const p = msg.params ?? {}
      if (p.requestId) urlByRequest.set(p.requestId, p.response?.url ?? null)
      continue
    }
    if (entry.dir === 'out' && msg.method === 'Network.getResponseBody') {
      requestByCommandId.set(msg.id, msg.params?.requestId ?? null)
      continue
    }
    if (entry.dir === 'in' && msg.id !== undefined && requestByCommandId.has(msg.id)) {
      const requestId = requestByCommandId.get(msg.id)
      requestByCommandId.delete(msg.id)
      if (msg.error || !msg.result) continue
      const text = decodeBody(msg.result)
      if (!text) continue
      const url = urlByRequest.get(requestId) ?? null
      bodies.push({ requestId, url, text })
      collector.ingest(text, { url })
    }
  }
  return { collector, bodies }
}

/**
 * Parse a `.jsonl` transcript file into entries.
 * @param {string} file
 */
export async function readTranscript(file) {
  const raw = await readFile(file, 'utf8')
  const entries = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      entries.push(JSON.parse(t))
    } catch {
      /* a truncated final line from an interrupted recording is fine to drop */
    }
  }
  return entries
}

/** List `.conflict.json` files already sitting in a store directory. */
export async function listConflictFiles(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.conflict.json')).sort()
  } catch {
    return []
  }
}

/**
 * Live capture: attach to the running Chrome, enable the network domain, and pull
 * the body of every response it reports until the user hits Ctrl-C.
 *
 * @param {object} opts
 * @param {number} [opts.port]
 * @param {string} [opts.out] store directory
 * @param {string} [opts.match] target URL substring
 * @param {number|null} [opts.targetIndex]
 * @param {string|null} [opts.record] path to write a raw CDP transcript to
 * @param {(targets:any[])=>Promise<number>} [opts.choose]
 * @param {{write:(s:string)=>void, isTTY?:boolean}} [opts.stdout]
 * @param {{write:(s:string)=>void, isTTY?:boolean}} [opts.stderr]
 * @param {AbortSignal} [opts.signal] abort to stop and flush
 * @returns {Promise<{ prompts:number, versions:number, addedVersions:number, conflicts:number, files:string[], conflictFiles:string[], target:any, bodiesSeen:number }>}
 */
export async function runCapture(opts = {}) {
  const {
    port = DEFAULT_PORT,
    out = 'prompts',
    match = DEFAULT_MATCH,
    targetIndex = null,
    record = null,
    choose,
    stdout = process.stdout,
    stderr = process.stderr,
    signal,
    fetchImpl,
    WebSocketImpl,
  } = opts

  const recordQueue = []
  let recordChain = Promise.resolve()
  const recorder = record
    ? (entry) => {
        recordQueue.push(entry)
        recordChain = recordChain
          .then(() => appendFile(record, `${JSON.stringify(entry)}\n`, 'utf8'))
          .catch(() => {
            /* a failed recording must never break a capture */
          })
      }
    : undefined

  const existing = await readStore(out)
  const collector = new CaptureCollector({ store: existing })
  const startingVersions = collector.versionCount

  const { session, target, candidates } = await attach({
    port,
    match,
    index: targetIndex,
    choose,
    recorder,
    fetchImpl,
    WebSocketImpl,
  })

  stdout.write(`attached to: ${target.title || target.url}\n`)
  stdout.write(`  ${target.url}\n`)
  if (candidates.length > 1) stdout.write(`  (${candidates.length} matching tabs; using #${candidates.indexOf(target)})\n`)
  if (record) stdout.write(`recording CDP transcript to ${record}\n`)
  stdout.write(
    collector.promptCount
      ? `loaded ${collector.promptCount} prompt(s) / ${collector.versionCount} version(s) already in ${out}/\n\n`
      : `\n`,
  )

  let dirty = false
  const pendingBodies = new Set()
  const retryOnFinish = new Map()

  const paint = () => {
    const line = collector.statusLine()
    if (stderr.isTTY) stderr.write(`\r\x1b[2K${line}`)
    else stderr.write(`${line}\n`)
  }
  paint()

  const takeBody = async (requestId, url) => {
    const key = requestId
    pendingBodies.add(key)
    try {
      const result = await session.send('Network.getResponseBody', { requestId })
      const text = decodeBody(result)
      const before = collector.versionCount + collector.promptCount
      collector.ingest(text, { url })
      if (collector.versionCount + collector.promptCount !== before) {
        dirty = true
        paint()
      }
      return true
    } catch (err) {
      if (err instanceof CdpProtocolError) return false
      return false
    } finally {
      pendingBodies.delete(key)
    }
  }

  session.on('Network.responseReceived', (params) => {
    const { requestId, response } = params
    if (!requestId) return
    if (isBinaryMime(response?.mimeType)) return
    const url = response?.url ?? null
    // Register the retry intent *before* awaiting, because loadingFinished can
    // arrive while the first getResponseBody is still in flight.
    const promise = takeBody(requestId, url)
    retryOnFinish.set(requestId, { url, promise })
    promise.then((ok) => {
      if (ok) retryOnFinish.delete(requestId)
    })
  })

  session.on('Network.loadingFinished', (params) => {
    const { requestId } = params
    const attempt = requestId && retryOnFinish.get(requestId)
    if (!attempt) return
    retryOnFinish.delete(requestId)
    // Streaming and still-loading bodies are not readable at responseReceived
    // time; once loading finishes, try exactly once more.
    attempt.promise.then((ok) => {
      if (!ok) takeBody(requestId, attempt.url)
    })
  })

  await session.send('Network.enable')

  let closedReason = null
  await new Promise((resolve) => {
    const stop = () => resolve()
    if (signal) {
      if (signal.aborted) return stop()
      signal.addEventListener('abort', stop, { once: true })
    }
    session.on('__close', ({ reason }) => {
      closedReason = reason || 'the tab was closed'
      stop()
    })
  })

  if (stderr.isTTY) stderr.write('\n')
  session.close()
  await recordChain

  const capturedAt = new Date().toISOString()
  const written = await writeStore(out, collector.store, { capturedAt, conflicts: collector.conflicts })

  if (closedReason) stdout.write(`\nChrome closed the connection (${closedReason}); saving what was captured.\n`)

  return {
    prompts: collector.promptCount,
    versions: collector.versionCount,
    addedVersions: collector.versionCount - startingVersions,
    conflicts: collector.conflicts.length,
    files: written.files,
    conflictFiles: written.conflictFiles,
    target,
    bodiesSeen: collector.bodiesSeen,
    dirty,
    recorded: record ? recordQueue.length : 0,
  }
}
