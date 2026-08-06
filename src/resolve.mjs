/**
 * pmpt-eject — the resolver. This is the package main.
 *
 * Replaces OpenAI's managed `prompt: { id, version, variables }` object with a
 * store you own, while keeping the one thing that made the managed object worth
 * using: you can edit a prompt in a git repo (or any static host) and a running
 * process picks it up within `ttlMs`, with no redeploy.
 *
 *   const prompts = createPromptResolver({ source: 'https://raw.githubusercontent.com/me/app/main/prompts' })
 *   await client.responses.create(await prompts.expand({ id: 'pmpt_abc', version: '2', variables: { customer_name: 'Acme' } }))
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { INDEX_FILE, PLACEHOLDER_RE, highestVersion } from './capture.mjs'

export { SHUTDOWN_ISO, SHUTDOWN_LABEL, SOURCE_URL, daysUntilShutdown, countdownLine } from './deadline.mjs'

/** The requested prompt id is not in the store. */
export class PromptNotFoundError extends Error {
  /** @param {{ id:string, available:string[], source:string }} info */
  constructor({ id, available, source }) {
    const body = available.length
      ? `Available ids: ${available.join(', ')}`
      : `The store at ${source} is empty — run \`pmpt-eject capture\` to rescue your prompts before they are deleted.`
    super(`Prompt "${id}" is not in the store at ${source}. ${body}`)
    this.name = 'PromptNotFoundError'
    this.code = 'PROMPT_NOT_FOUND'
    this.id = id
    this.available = available
    this.source = source
  }
}

/** The prompt exists but not at that version. */
export class PromptVersionNotFoundError extends Error {
  /** @param {{ id:string, version:string, available:string[], source:string }} info */
  constructor({ id, version, available, source }) {
    super(
      `Prompt "${id}" has no version "${version}". Available versions: ${available.length ? available.join(', ') : '(none captured)'}.`,
    )
    this.name = 'PromptVersionNotFoundError'
    this.code = 'PROMPT_VERSION_NOT_FOUND'
    this.id = id
    this.version = version
    this.available = available
    this.source = source
  }
}

/** The source could not be read and there is no cached copy to fall back on. */
export class SourceUnavailableError extends Error {
  constructor(message, { source, resource, status, cause } = {}) {
    super(message, { cause })
    this.name = 'SourceUnavailableError'
    this.code = 'SOURCE_UNAVAILABLE'
    this.source = source
    this.resource = resource
    this.status = status ?? null
  }
}

/** The store was read but is not in the pmpt-eject on-disk format. */
export class InvalidStoreError extends Error {
  constructor(message, { source, resource } = {}) {
    super(message)
    this.name = 'InvalidStoreError'
    this.code = 'INVALID_STORE'
    this.source = source
    this.resource = resource
  }
}

const isRemote = (s) => /^https?:\/\//i.test(s)

/**
 * Substitute `{{name}}` placeholders. Unknown placeholders are left exactly as
 * they are and reported back to the caller.
 *
 * @param {string} text
 * @param {Record<string, any>} variables
 * @param {Set<string>} [unresolved] collected into, if given
 * @returns {string}
 */
export function substitute(text, variables = {}, unresolved) {
  if (typeof text !== 'string') return text
  return text.replace(PLACEHOLDER_RE, (match, name) => {
    if (Object.hasOwn(variables ?? {}, name)) {
      const v = variables[name]
      return v === null || v === undefined ? '' : String(v)
    }
    unresolved?.add(name)
    return match
  })
}

class Loader {
  /**
   * @param {{ source:string, fetchImpl?:typeof fetch, timeoutMs?:number }} opts
   */
  constructor({ source, fetchImpl = fetch, timeoutMs = 10_000 }) {
    this.rawSource = source
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.remote = isRemote(source)
    if (this.remote) {
      this.base = new URL(source.endsWith('/') ? source : `${source}/`)
      this.label = this.base.href
    } else if (source.startsWith('file://')) {
      this.remote = false
      this.dir = fileURLToPath(source.endsWith('/') ? source : `${source}/`)
      this.label = this.dir
    } else {
      this.dir = path.resolve(source)
      this.label = this.dir
    }
  }

  /** @param {string} resource file name relative to the store root */
  async load(resource) {
    return this.remote ? this.#loadRemote(resource) : this.#loadLocal(resource)
  }

  async #loadLocal(resource) {
    const file = path.join(this.dir, resource)
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (cause) {
      if (cause.code === 'ENOENT') {
        throw new SourceUnavailableError(
          resource === INDEX_FILE
            ? `No prompt store at ${this.dir} (expected ${INDEX_FILE}). Run \`pmpt-eject capture --out ${this.dir}\` first.`
            : `Prompt file ${resource} is listed in ${INDEX_FILE} but missing from ${this.dir}.`,
          { source: this.label, resource, cause },
        )
      }
      throw new SourceUnavailableError(`Could not read ${file}: ${cause.message}`, {
        source: this.label,
        resource,
        cause,
      })
    }
    return this.#parse(raw, resource)
  }

  async #loadRemote(resource) {
    const url = new URL(resource, this.base)
    let res
    try {
      res = await this.fetchImpl(url.href, { signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (cause) {
      const why = cause?.name === 'TimeoutError' ? `timed out after ${this.timeoutMs}ms` : (cause?.message ?? String(cause))
      throw new SourceUnavailableError(`Could not fetch ${url.href}: ${why}`, {
        source: this.label,
        resource,
        cause,
      })
    }
    if (res.status === 429) {
      const retry = res.headers.get('retry-after')
      throw new SourceUnavailableError(
        `Rate limited (HTTP 429) fetching ${url.href}${retry ? ` — retry after ${retry}s` : ''}. Raise ttlMs to fetch less often.`,
        { source: this.label, resource, status: 429 },
      )
    }
    if (res.status === 404) {
      throw new SourceUnavailableError(
        resource === INDEX_FILE
          ? `No ${INDEX_FILE} at ${url.href} (HTTP 404). Point \`source\` at the directory that contains ${INDEX_FILE}.`
          : `Prompt file ${resource} is listed in ${INDEX_FILE} but returned HTTP 404 at ${url.href}.`,
        { source: this.label, resource, status: 404 },
      )
    }
    if (!res.ok) {
      throw new SourceUnavailableError(`HTTP ${res.status} fetching ${url.href}.`, {
        source: this.label,
        resource,
        status: res.status,
      })
    }
    return this.#parse(await res.text(), resource)
  }

  #parse(raw, resource) {
    try {
      const json = JSON.parse(raw)
      if (!json || typeof json !== 'object') throw new Error('not an object')
      return json
    } catch (cause) {
      throw new InvalidStoreError(`${resource} in ${this.label} is not valid JSON: ${cause.message}`, {
        source: this.label,
        resource,
      })
    }
  }
}

/**
 * @typedef {object} ResolverOptions
 * @property {string} source local directory or https URL serving index.json
 * @property {number} [ttlMs] how stale a cached copy may be before a background refresh (default 60000)
 * @property {(message:string, detail?:any)=>void} [onWarning] default: console.warn
 * @property {typeof fetch} [fetchImpl]
 * @property {()=>number} [now] injectable clock, for tests
 * @property {number} [timeoutMs] per-request timeout for remote sources (default 10000)
 */

/**
 * Create a resolver over a prompt store.
 * @param {ResolverOptions} options
 */
export function createPromptResolver(options = {}) {
  const {
    source,
    ttlMs = 60_000,
    onWarning = (msg) => console.warn(`[pmpt-eject] ${msg}`),
    fetchImpl,
    now = () => Date.now(),
    timeoutMs,
  } = options

  if (typeof source !== 'string' || !source.trim()) {
    throw new TypeError(
      'createPromptResolver({ source }) needs a source: a local directory containing index.json, or an https URL serving it.',
    )
  }
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new TypeError(`createPromptResolver({ ttlMs }) must be a non-negative number, got ${ttlMs}.`)
  }

  const loader = new Loader({ source, fetchImpl, timeoutMs })
  /** @type {Map<string, { value:any, fetchedAt:number, refreshing:Promise<any>|null, failedAt:number|null, lastError:Error|null }>} */
  const cache = new Map()
  const inflight = new Set()
  const failureBackoffMs = Math.min(ttlMs, 10_000)

  const fetchResource = async (resource) => {
    const value = await loader.load(resource)
    cache.set(resource, { value, fetchedAt: now(), refreshing: null, failedAt: null, lastError: null })
    return value
  }

  const track = (p) => {
    inflight.add(p)
    p.finally(() => inflight.delete(p)).catch(() => {})
    return p
  }

  /**
   * Stale-while-revalidate: a fresh entry is returned as-is, a stale one is
   * returned immediately while a refresh runs in the background, and a refresh
   * that fails warns and keeps serving the stale copy rather than throwing.
   */
  const load = async (resource) => {
    const entry = cache.get(resource)
    if (!entry) return track(fetchResource(resource))

    const age = now() - entry.fetchedAt
    if (age <= ttlMs) return entry.value

    if (entry.failedAt !== null && now() - entry.failedAt < failureBackoffMs) return entry.value

    if (!entry.refreshing) {
      entry.refreshing = track(
        fetchResource(resource)
          .catch((err) => {
            const current = cache.get(resource) ?? entry
            current.failedAt = now()
            current.lastError = err
            current.refreshing = null
            onWarning(
              `serving a stale copy of ${resource} from ${loader.label}: ${err.message}`,
              err,
            )
            return current.value
          })
          .finally(() => {
            const current = cache.get(resource)
            if (current) current.refreshing = null
          }),
      )
    }
    return entry.value
  }

  const loadIndex = async () => {
    const index = await load(INDEX_FILE)
    if (!Array.isArray(index.prompts)) {
      throw new InvalidStoreError(
        `${INDEX_FILE} in ${loader.label} has no "prompts" array — is this a pmpt-eject store?`,
        { source: loader.label, resource: INDEX_FILE },
      )
    }
    return index
  }

  const resolver = {
    source: loader.label,
    ttlMs,

    /** Ids currently in the store. */
    async ids() {
      const index = await loadIndex()
      return index.prompts.map((p) => p.id).filter(Boolean)
    },

    /** Every prompt with its captured versions. */
    async list() {
      const index = await loadIndex()
      const out = []
      for (const meta of index.prompts) {
        if (!meta?.id) continue
        let versions = []
        try {
          const body = await load(meta.file ?? `${meta.id}.json`)
          versions = Object.keys(body.versions ?? {})
        } catch (err) {
          onWarning(`could not read ${meta.file} for ${meta.id}: ${err.message}`, err)
        }
        out.push({ id: meta.id, name: meta.name ?? null, latest: meta.latest ?? highestVersion(versions), versions })
      }
      return out
    },

    /**
     * Expand a prompt into arguments for `client.responses.create()`.
     *
     * `unresolved`, `promptId` and `promptVersion` are attached as
     * non-enumerable properties, so spreading or JSON-serialising the result
     * sends only `instructions` / `input` / `model` to OpenAI.
     *
     * @param {{ id:string, version?:string|number, variables?:Record<string, any> }} request
     * @returns {Promise<{ instructions?:string, input:Array<{role:string,content:string}>, model?:string }>}
     */
    async expand(request = {}) {
      const { id, version, variables = {} } = request
      if (typeof id !== 'string' || !id) {
        throw new TypeError('expand({ id }) needs a prompt id, e.g. { id: "pmpt_abc" }.')
      }
      if (variables !== null && (typeof variables !== 'object' || Array.isArray(variables))) {
        throw new TypeError('expand({ variables }) must be a plain object of placeholder values.')
      }

      const index = await loadIndex()
      const meta = index.prompts.find((p) => p?.id === id)
      if (!meta) {
        throw new PromptNotFoundError({
          id,
          available: index.prompts.map((p) => p?.id).filter(Boolean),
          source: loader.label,
        })
      }

      const body = await load(meta.file ?? `${meta.id}.json`)
      const versions = body.versions ?? {}
      const available = Object.keys(versions)
      const wanted = version === undefined || version === null ? (highestVersion(available) ?? null) : String(version)

      if (wanted === null) {
        throw new PromptVersionNotFoundError({ id, version: '(latest)', available, source: loader.label })
      }
      const entry = versions[wanted]
      if (!entry) {
        throw new PromptVersionNotFoundError({ id, version: wanted, available, source: loader.label })
      }

      const unresolved = new Set()
      /** @type {any} */
      const result = {}
      if (typeof entry.instructions === 'string') {
        result.instructions = substitute(entry.instructions, variables, unresolved)
      }
      result.input = (entry.messages ?? []).map((m) => ({
        role: m.role,
        content: substitute(m.content, variables, unresolved),
      }))
      if (typeof entry.model === 'string') result.model = entry.model

      const hidden = (key, value) =>
        Object.defineProperty(result, key, { value, enumerable: false, writable: false, configurable: true })
      hidden('unresolved', [...unresolved].sort())
      hidden('promptId', id)
      hidden('promptVersion', wanted)
      return result
    },

    /** Force a refresh of everything currently cached. Never throws. */
    async refresh() {
      const keys = [...cache.keys()]
      const refreshed = []
      for (const key of keys) {
        try {
          await fetchResource(key)
          refreshed.push(key)
        } catch (err) {
          const current = cache.get(key)
          if (current) {
            current.failedAt = now()
            current.lastError = err
          }
          onWarning(`refresh of ${key} failed: ${err.message}`, err)
        }
      }
      return refreshed
    },

    /** Await any background revalidation. Useful in tests and before exit. */
    async settled() {
      while (inflight.size) await Promise.allSettled([...inflight])
    },

    /** Drop everything cached. */
    clearCache() {
      cache.clear()
    },

    /** Inspect the cache — age per resource, and the last error if any. */
    cacheState() {
      const t = now()
      return [...cache.entries()].map(([resource, e]) => ({
        resource,
        ageMs: t - e.fetchedAt,
        stale: t - e.fetchedAt > ttlMs,
        lastError: e.lastError ? e.lastError.message : null,
      }))
    },
  }

  return resolver
}

export default createPromptResolver
export { INDEX_FILE }
