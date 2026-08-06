/**
 * Raw Chrome DevTools Protocol client — target discovery, WebSocket transport,
 * request/response correlation. No puppeteer, no playwright, no dependencies.
 *
 * This attaches to a Chrome the user already started and is already logged into.
 * It never drives a login and never touches credentials.
 */

/** Default remote-debugging port, per Chrome's own `--remote-debugging-port=9222`. */
export const DEFAULT_PORT = 9222

/** The dashboard host whose traffic we sniff. */
export const DEFAULT_MATCH = 'platform.openai.com'

/** Chrome is not listening / not started with --remote-debugging-port. */
export class CdpUnavailableError extends Error {
  constructor(message, { cause, port = DEFAULT_PORT } = {}) {
    super(message, { cause })
    this.name = 'CdpUnavailableError'
    this.code = 'CDP_UNAVAILABLE'
    this.port = port
  }
}

/** Chrome is listening but no matching tab is open. */
export class NoTargetError extends Error {
  constructor(message, { match = DEFAULT_MATCH, targets = [] } = {}) {
    super(message)
    this.name = 'NoTargetError'
    this.code = 'CDP_NO_TARGET'
    this.match = match
    this.targets = targets
  }
}

/** A CDP command came back with an error, or the socket died mid-flight. */
export class CdpProtocolError extends Error {
  constructor(message, { method, cdpCode } = {}) {
    super(message)
    this.name = 'CdpProtocolError'
    this.code = 'CDP_PROTOCOL'
    this.method = method
    this.cdpCode = cdpCode
  }
}

/**
 * The exact remedy printed when Chrome is not listening. One line, no stack.
 * @param {number} port
 */
export function startChromeHint(port = DEFAULT_PORT) {
  const flag = `--remote-debugging-port=${port}`
  return [
    `Chrome is not listening on 127.0.0.1:${port}.`,
    `Fix: quit Chrome completely, then start it once with the debugging port open:`,
    `  Windows   "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ${flag}`,
    `  macOS     open -a "Google Chrome" --args ${flag}`,
    `  Linux     google-chrome ${flag}`,
    `Then sign in to https://platform.openai.com/prompts as usual and re-run this command.`,
  ].join('\n')
}

/**
 * List page targets from Chrome's HTTP discovery endpoint.
 *
 * @param {{ port?: number, host?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<Array<{id:string,title:string,url:string,type:string,webSocketDebuggerUrl:string}>>}
 */
export async function listTargets(opts = {}) {
  const { port = DEFAULT_PORT, host = '127.0.0.1', fetchImpl = fetch, timeoutMs = 5000 } = opts
  let res
  try {
    res = await fetchImpl(`http://${host}:${port}/json`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (cause) {
    throw new CdpUnavailableError(startChromeHint(port), { cause, port })
  }
  if (!res.ok) {
    throw new CdpUnavailableError(
      `Chrome answered on 127.0.0.1:${port} with HTTP ${res.status}. Is something else using that port?`,
      { port },
    )
  }
  let json
  try {
    json = await res.json()
  } catch (cause) {
    throw new CdpUnavailableError(
      `127.0.0.1:${port} answered but did not return the DevTools target list. Is something else using that port?`,
      { cause, port },
    )
  }
  if (!Array.isArray(json)) {
    throw new CdpUnavailableError(
      `127.0.0.1:${port} returned an unexpected target list. Is something else using that port?`,
      { port },
    )
  }
  return json.filter((t) => t && t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
}

/**
 * Narrow a target list to the pages we care about.
 * @param {Array<{url?:string}>} targets
 * @param {string} [match] substring matched against the target URL
 */
export function selectTargets(targets, match = DEFAULT_MATCH) {
  return targets.filter((t) => typeof t.url === 'string' && t.url.includes(match))
}

/**
 * A live CDP session over one page target.
 *
 * Correlates `{id}` request/response pairs, fans out events to listeners, and
 * optionally hands every frame in both directions to a recorder so a session can
 * be replayed offline in tests.
 */
export class CdpSession {
  #ws = null
  #nextId = 1
  #pending = new Map()
  #listeners = new Map()
  #recorder = null
  #closed = false
  #closeReason = null
  #WebSocketImpl
  #timeoutMs
  #now

  /**
   * @param {string} wsUrl webSocketDebuggerUrl from the target list
   * @param {{ WebSocketImpl?: any, timeoutMs?: number, recorder?: (entry:any)=>void, now?: ()=>number }} [opts]
   */
  constructor(wsUrl, opts = {}) {
    this.wsUrl = wsUrl
    this.#WebSocketImpl = opts.WebSocketImpl ?? globalThis.WebSocket
    this.#timeoutMs = opts.timeoutMs ?? 20_000
    this.#recorder = opts.recorder ?? null
    this.#now = opts.now ?? (() => Date.now())
    if (typeof this.#WebSocketImpl !== 'function') {
      throw new CdpUnavailableError(
        'No global WebSocket. pmpt-eject needs Node 22 or newer (node --version).',
      )
    }
  }

  /** Open the socket. Resolves once connected. */
  open() {
    return new Promise((resolve, reject) => {
      let ws
      try {
        ws = new this.#WebSocketImpl(this.wsUrl)
      } catch (cause) {
        reject(new CdpUnavailableError(`Could not open ${this.wsUrl}`, { cause }))
        return
      }
      this.#ws = ws
      const onOpenError = (ev) => {
        reject(
          new CdpUnavailableError(
            `Could not attach to the Chrome tab (${this.wsUrl}). Is DevTools open on it, or did the tab close?`,
            { cause: ev?.error },
          ),
        )
      }
      ws.addEventListener('error', onOpenError, { once: true })
      ws.addEventListener(
        'open',
        () => {
          ws.removeEventListener('error', onOpenError)
          ws.addEventListener('error', () => {
            /* surfaced through close / pending rejections */
          })
          ws.addEventListener('message', (ev) => this.#onMessage(ev))
          ws.addEventListener('close', (ev) => this.#onClose(ev))
          resolve(this)
        },
        { once: true },
      )
    })
  }

  #onMessage(ev) {
    const raw = typeof ev.data === 'string' ? ev.data : String(ev.data)
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    this.#recorder?.({ dir: 'in', at: this.#now(), msg })
    if (msg.id !== undefined && this.#pending.has(msg.id)) {
      const { resolve, reject, method, timer } = this.#pending.get(msg.id)
      this.#pending.delete(msg.id)
      clearTimeout(timer)
      if (msg.error) {
        reject(
          new CdpProtocolError(`${method}: ${msg.error.message ?? 'unknown CDP error'}`, {
            method,
            cdpCode: msg.error.code,
          }),
        )
      } else {
        resolve(msg.result ?? {})
      }
      return
    }
    if (msg.method) {
      for (const cb of this.#listeners.get(msg.method) ?? []) {
        try {
          cb(msg.params ?? {}, msg)
        } catch {
          /* a listener throwing must not kill the session */
        }
      }
      for (const cb of this.#listeners.get('*') ?? []) {
        try {
          cb(msg.params ?? {}, msg)
        } catch {
          /* ignore */
        }
      }
    }
  }

  #onClose(ev) {
    this.#closed = true
    this.#closeReason = ev?.reason || null
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer)
      p.reject(new CdpProtocolError(`Chrome closed the debugging connection during ${p.method}.`, { method: p.method }))
    }
    this.#pending.clear()
    for (const cb of this.#listeners.get('__close') ?? []) {
      try {
        cb({ reason: this.#closeReason })
      } catch {
        /* ignore */
      }
    }
  }

  get closed() {
    return this.#closed
  }

  /**
   * Send a CDP command and await its result.
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  send(method, params = {}) {
    if (this.#closed) {
      return Promise.reject(new CdpProtocolError(`Session is closed; cannot send ${method}.`, { method }))
    }
    const id = this.#nextId++
    const payload = { id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new CdpProtocolError(`${method} timed out after ${this.#timeoutMs}ms.`, { method }))
      }, this.#timeoutMs)
      timer.unref?.()
      this.#pending.set(id, { resolve, reject, method, timer })
      this.#recorder?.({ dir: 'out', at: this.#now(), msg: payload })
      try {
        this.#ws.send(JSON.stringify(payload))
      } catch (cause) {
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(new CdpProtocolError(`Could not send ${method}: ${cause?.message ?? cause}`, { method }))
      }
    })
  }

  /**
   * Subscribe to a CDP event. `'*'` receives every event; `'__close'` fires when
   * the socket drops.
   * @param {string} event
   * @param {(params:any, msg:any)=>void} cb
   * @returns {() => void} unsubscribe
   */
  on(event, cb) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set())
    this.#listeners.get(event).add(cb)
    return () => this.#listeners.get(event)?.delete(cb)
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#ws?.close()
    } catch {
      /* already gone */
    }
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer)
      p.reject(new CdpProtocolError(`Session closed locally during ${p.method}.`, { method: p.method }))
    }
    this.#pending.clear()
  }
}

/**
 * Discover targets and connect to exactly one.
 *
 * @param {{ port?: number, match?: string, index?: number|null, choose?: (targets:any[])=>Promise<number>, recorder?: (e:any)=>void, fetchImpl?: typeof fetch, WebSocketImpl?: any }} [opts]
 * @returns {Promise<{ session: CdpSession, target: any, candidates: any[] }>}
 */
export async function attach(opts = {}) {
  const {
    port = DEFAULT_PORT,
    match = DEFAULT_MATCH,
    index = null,
    choose = null,
    recorder,
    fetchImpl,
    WebSocketImpl,
  } = opts
  const all = await listTargets({ port, fetchImpl })
  const candidates = selectTargets(all, match)
  if (candidates.length === 0) {
    throw new NoTargetError(
      [
        `No open tab matching "${match}" in the Chrome on port ${port}.`,
        `Fix: open https://platform.openai.com/prompts in that Chrome window, sign in, then re-run.`,
        all.length
          ? `(${all.length} other tab${all.length === 1 ? ' is' : 's are'} open, none of them matched.)`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      { match, targets: all },
    )
  }
  let picked = 0
  if (candidates.length > 1) {
    if (Number.isInteger(index)) {
      if (index < 0 || index >= candidates.length) {
        throw new NoTargetError(
          `--target ${index} is out of range; ${candidates.length} matching tabs were found (0-${candidates.length - 1}).`,
          { match, targets: candidates },
        )
      }
      picked = index
    } else if (choose) {
      picked = await choose(candidates)
    }
  } else if (Number.isInteger(index) && index !== 0) {
    throw new NoTargetError(`--target ${index} is out of range; only 1 matching tab was found (0).`, {
      match,
      targets: candidates,
    })
  }
  const target = candidates[picked]
  const session = new CdpSession(target.webSocketDebuggerUrl, { recorder, WebSocketImpl })
  await session.open()
  return { session, target, candidates }
}
