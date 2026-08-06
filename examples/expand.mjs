/**
 * The README's worked example, runnable.
 *
 *   node examples/expand.mjs
 *
 * Resolves against the test fixture store so it runs with no network and no
 * OpenAI key. Point `source` at your own prompts/ (or a raw.githubusercontent.com
 * URL) and the `client.responses.create(...)` line below is the whole migration.
 */

import { createPromptResolver } from '../src/resolve.mjs'

const prompts = createPromptResolver({ source: new URL('../test/fixtures/prompts', import.meta.url).href })

// Before: await client.responses.create({ prompt: { id: 'pmpt_abc', version: '2', variables: { customer_name: 'Acme' } } })
// After:
const args = await prompts.expand({ id: 'pmpt_abc', version: '2', variables: { customer_name: 'Acme' } })
console.log(args)
// → await client.responses.create(args)

console.log('\nunresolved placeholders:', args.unresolved)
console.log('spread onto the wire   :', Object.keys({ ...args }))

// Omitting `version` resolves to the highest numeric version…
const latest = await prompts.expand({ id: 'pmpt_abc', variables: { customer_name: 'Acme' } })
console.log('\nlatest version         :', latest.promptVersion)
console.log('unknown placeholders kept, and reported:', latest.unresolved)
console.log(latest.instructions)
