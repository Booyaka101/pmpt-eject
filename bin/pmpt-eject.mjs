#!/usr/bin/env node
/**
 * pmpt-eject — rescue OpenAI reusable prompt objects before v1/prompts shuts down
 * on 2026-11-30, and keep editing them afterwards without a redeploy.
 *
 * Exit codes: 0 ok · 1 gate failed (stranded ids under --strict) · 2 usage or environment error.
 */

import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'

import { CdpUnavailableError, NoTargetError, DEFAULT_PORT, DEFAULT_MATCH } from '../src/cdp.mjs'
import { runCapture, listConflictFiles, readStore, countVersions } from '../src/capture.mjs'
import { scan, formatScan, ScanPathError } from '../src/scan.mjs'
import {
  countdownLine,
  daysUntilShutdown,
  isPastShutdown,
  SHUTDOWN_LABEL,
  SOURCE_URL,
  DEPRECATIONS_URL,
  ANNOUNCED_ON,
} from '../src/deadline.mjs'

const EXIT_OK = 0
const EXIT_GATE = 1
const EXIT_ERROR = 2

const HELP = `pmpt-eject — get your OpenAI prompts out before ${SHUTDOWN_LABEL}, and keep hot-fixing them after.

USAGE
  pmpt-eject capture [options]      rescue prompts from your logged-in Chrome
  pmpt-eject scan [dir] [options]   find pmpt_ ids in your code, flag the unrescued
  pmpt-eject doctor [dir]           countdown + a scan summary
  pmpt-eject --help | --version

capture
  Attach to a Chrome you already started with --remote-debugging-port=9222 and
  already signed in. Nothing is typed for you and no credentials are stored.
  Open https://platform.openai.com/prompts, run this, then click through your
  prompts — every one you open gets written to disk. Ctrl-C when done.

  --port <n>        DevTools port (default ${DEFAULT_PORT})
  --out <dir>       store directory (default prompts)
  --match <str>     tab URL substring to attach to (default ${DEFAULT_MATCH})
  --target <n>      pick tab n when several match, instead of being asked
  --record <file>   also write the raw CDP transcript to <file> (jsonl)

scan
  --strict          exit 1 if any id is STRANDED — this is the CI gate
  --prompts <dir>   store to check against (default <dir>/prompts)
  --json            machine-readable output

doctor
  --prompts <dir>   store to check against (default <dir>/prompts)

EXIT CODES
  0 ok · 1 gate failed · 2 usage or environment error

After ${SHUTDOWN_LABEL}, capture stops being useful — there will be nothing left
to capture. The resolver (createPromptResolver) keeps working forever; it reads
the store you own.

  ${SOURCE_URL}
`

function fail(message, code = EXIT_ERROR) {
  process.stderr.write(`${message}\n`)
  process.exitCode = code
  return code
}

/** @param {string[]} argv */
export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : null
  const rest = command ? argv.slice(1) : argv

  if (argv.length === 0) {
    process.stdout.write(HELP)
    return fail('No command given.', EXIT_ERROR)
  }
  if (argv.includes('--help') || argv.includes('-h') || command === 'help') {
    process.stdout.write(HELP)
    return EXIT_OK
  }
  if (argv.includes('--version') || argv.includes('-v') || command === 'version') {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    process.stdout.write(`${pkg.version}\n`)
    return EXIT_OK
  }
  if (!command) return fail(`Expected a command. Run \`pmpt-eject --help\`.`)

  switch (command) {
    case 'capture':
      return cmdCapture(rest)
    case 'scan':
      return cmdScan(rest)
    case 'doctor':
      return cmdDoctor(rest)
    default:
      return fail(`Unknown command "${command}". Run \`pmpt-eject --help\`.`)
  }
}

function parse(rest, options) {
  try {
    return parseArgs({ args: rest, options, allowPositionals: true, strict: true })
  } catch (err) {
    fail(`${err.message}\nRun \`pmpt-eject --help\`.`)
    return null
  }
}

async function cmdCapture(rest) {
  const parsed = parse(rest, {
    port: { type: 'string' },
    out: { type: 'string' },
    match: { type: 'string' },
    target: { type: 'string' },
    record: { type: 'string' },
  })
  if (!parsed) return EXIT_ERROR
  const { values } = parsed

  const port = values.port ? Number(values.port) : DEFAULT_PORT
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return fail(`--port must be a port number, got "${values.port}".`)
  }
  const targetIndex = values.target === undefined ? null : Number(values.target)
  if (values.target !== undefined && !Number.isInteger(targetIndex)) {
    return fail(`--target must be a whole number, got "${values.target}".`)
  }
  const out = values.out ?? 'prompts'

  if (isPastShutdown()) {
    process.stderr.write(
      `note: ${countdownLine()}\n      Running anyway in case your tab still has data cached.\n\n`,
    )
  } else {
    process.stdout.write(`${countdownLine()}\n\n`)
  }

  const controller = new AbortController()
  const onSigint = () => {
    process.stderr.write('\nstopping…\n')
    controller.abort()
  }
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigint)

  const choose = async (targets) => {
    if (!process.stdin.isTTY) {
      throw new NoTargetError(
        [
          `${targets.length} tabs match. Re-run with --target <n>:`,
          ...targets.map((t, i) => `  ${i}  ${t.title || '(untitled)'} — ${t.url}`),
        ].join('\n'),
        { targets },
      )
    }
    process.stdout.write(`${targets.length} matching tabs:\n`)
    targets.forEach((t, i) => process.stdout.write(`  ${i}  ${t.title || '(untitled)'} — ${t.url}\n`))
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      for (;;) {
        const answer = (await rl.question(`which tab? [0-${targets.length - 1}] `)).trim()
        const n = Number(answer === '' ? '0' : answer)
        if (Number.isInteger(n) && n >= 0 && n < targets.length) return n
        process.stdout.write(`please enter a number between 0 and ${targets.length - 1}.\n`)
      }
    } finally {
      rl.close()
    }
  }

  try {
    const result = await runCapture({
      port,
      out,
      match: values.match ?? DEFAULT_MATCH,
      targetIndex,
      record: values.record ?? null,
      choose,
      signal: controller.signal,
    })

    process.stdout.write('\n')
    if (result.prompts === 0) {
      process.stdout.write(
        [
          `No prompts captured. ${result.bodiesSeen} response body/bodies were inspected.`,
          `That usually means the tab did not load any prompt data while this was attached.`,
          `Open https://platform.openai.com/prompts, click into each prompt (and each version),`,
          `then re-run — the content only crosses the wire when the dashboard renders it.`,
        ].join('\n') + '\n',
      )
      return EXIT_OK
    }
    process.stdout.write(
      `captured ${result.prompts} prompt(s) / ${result.versions} version(s) into ${path.resolve(out)}${path.sep}\n`,
    )
    process.stdout.write(`  ${result.addedVersions} new version(s) this run\n`)
    for (const f of result.files) process.stdout.write(`  ${f}\n`)
    if (result.conflicts) {
      process.stderr.write(
        `\nwarning: ${result.conflicts} version(s) already on disk had different content and were NOT overwritten.\n` +
          result.conflictFiles.map((f) => `  ${f}\n`).join('') +
          `Review those files and merge by hand.\n`,
      )
    }
    if (result.recorded) process.stdout.write(`  transcript: ${result.recorded} CDP frame(s) -> ${values.record}\n`)
    process.stdout.write(`\nNext: \`pmpt-eject scan .\` to find any ids in your code that are still stranded.\n`)
    return EXIT_OK
  } catch (err) {
    if (err instanceof CdpUnavailableError || err instanceof NoTargetError) return fail(err.message)
    return fail(`capture failed: ${err.message}`)
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigint)
  }
}

async function cmdScan(rest) {
  const parsed = parse(rest, {
    strict: { type: 'boolean', default: false },
    prompts: { type: 'string' },
    json: { type: 'boolean', default: false },
  })
  if (!parsed) return EXIT_ERROR
  const { values, positionals } = parsed
  const dir = positionals[0] ?? '.'

  try {
    const result = await scan(dir, { promptsDir: values.prompts })
    if (values.json) {
      process.stdout.write(`${JSON.stringify(
        {
          root: result.root,
          promptsDir: result.promptsDir,
          filesScanned: result.filesScanned,
          captured: result.capturedCount,
          stranded: result.stranded.length,
          results: result.results,
        },
        null,
        2,
      )}\n`)
    } else {
      process.stdout.write(`${formatScan(result, { color: process.stdout.isTTY })}\n`)
    }

    if (result.stranded.length && !values.json) {
      process.stderr.write(
        `\n${result.stranded.length} id(s) have no captured content. Run \`pmpt-eject capture\` with those prompts open in your dashboard.\n`,
      )
    }
    if (values.strict && result.stranded.length) {
      if (!values.json) {
        process.stderr.write(`--strict: failing because ${result.stranded.length} id(s) are stranded.\n`)
      }
      process.exitCode = EXIT_GATE
      return EXIT_GATE
    }
    return EXIT_OK
  } catch (err) {
    if (err instanceof ScanPathError) return fail(err.message)
    return fail(`scan failed: ${err.message}`)
  }
}

async function cmdDoctor(rest) {
  const parsed = parse(rest, { prompts: { type: 'string' } })
  if (!parsed) return EXIT_ERROR
  const { values, positionals } = parsed
  const dir = positionals[0] ?? '.'
  const days = daysUntilShutdown()

  const lines = []
  lines.push('pmpt-eject doctor')
  lines.push('')
  lines.push(`deadline   ${SHUTDOWN_LABEL} — v1/prompts shuts down`)
  lines.push(
    `remaining  ${days > 0 ? `${days} day${days === 1 ? '' : 's'}` : `PASSED ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`}`,
  )
  lines.push(`announced  ${ANNOUNCED_ON}`)
  lines.push(`source     ${SOURCE_URL}`)
  lines.push(`           ${DEPRECATIONS_URL}`)
  lines.push('')

  const promptsDir = path.resolve(values.prompts ?? path.join(path.resolve(dir), 'prompts'))
  let store
  try {
    store = await readStore(promptsDir)
  } catch (err) {
    lines.push(`store      UNREADABLE — ${err.message}`)
    process.stdout.write(`${lines.join('\n')}\n`)
    return fail('doctor: the prompt store could not be read (see above).')
  }

  if (!store.prompts.size) {
    lines.push(`store      none at ${promptsDir}`)
    lines.push(`           nothing has been rescued yet — run \`pmpt-eject capture\``)
  } else {
    lines.push(`store      ${promptsDir}`)
    lines.push(`           ${store.prompts.size} prompt(s), ${countVersions(store)} version(s), captured ${store.capturedAt ?? 'unknown'}`)
    if (store.missingFiles.length) {
      lines.push(`           WARNING: ${store.missingFiles.length} file(s) listed in index.json are missing: ${store.missingFiles.join(', ')}`)
    }
    const conflicts = await listConflictFiles(promptsDir)
    if (conflicts.length) {
      lines.push(`           WARNING: unmerged conflicts in ${conflicts.join(', ')}`)
    }
  }
  lines.push('')

  let scanResult = null
  try {
    scanResult = await scan(dir, { promptsDir })
  } catch (err) {
    lines.push(`scan       could not scan ${path.resolve(dir)}: ${err.message}`)
  }

  if (scanResult) {
    lines.push(`scan       ${scanResult.root}`)
    lines.push(`           ${scanResult.filesScanned} file(s) scanned, ${scanResult.results.length} unique pmpt_ id(s) referenced`)
    lines.push(`           ${scanResult.capturedCount} CAPTURED, ${scanResult.stranded.length} STRANDED`)
    for (const s of scanResult.stranded.slice(0, 10)) {
      lines.push(`           STRANDED ${s.id}  ${s.refs[0].file}:${s.refs[0].line}`)
    }
    if (scanResult.stranded.length > 10) {
      lines.push(`           …and ${scanResult.stranded.length - 10} more (run \`pmpt-eject scan\`)`)
    }
  }

  lines.push('')
  if (scanResult && scanResult.stranded.length) {
    lines.push(`verdict    NOT SAFE — ${scanResult.stranded.length} id(s) in your code would break on ${SHUTDOWN_LABEL}.`)
    lines.push(`           Next: \`pmpt-eject capture\` with those prompts open in your dashboard.`)
  } else if (scanResult && scanResult.results.length) {
    lines.push(`verdict    SAFE — every pmpt_ id in this tree has captured content on disk.`)
    lines.push(`           Next: swap client.responses.create({ prompt: … }) for createPromptResolver().expand(…).`)
  } else {
    lines.push(`verdict    no pmpt_ ids referenced in this tree.`)
  }

  process.stdout.write(`${lines.join('\n')}\n`)
  return EXIT_OK
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const code = await main()
    if (process.exitCode === undefined) process.exitCode = code
  } catch (err) {
    // Nothing should reach here; if it does, it is still not a stack trace.
    process.stderr.write(`pmpt-eject: ${err?.message ?? err}\n`)
    process.exitCode = EXIT_ERROR
  }
}
