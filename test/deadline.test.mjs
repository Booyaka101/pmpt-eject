import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  SHUTDOWN_ISO,
  SHUTDOWN_LABEL,
  ANNOUNCED_ON,
  SOURCE_URL,
  daysUntilShutdown,
  isPastShutdown,
  countdownLine,
} from '../src/deadline.mjs'

describe('the deadline', () => {
  test('is the date OpenAI published', () => {
    assert.equal(SHUTDOWN_ISO, '2026-11-30T00:00:00.000Z')
    assert.equal(SHUTDOWN_LABEL, 'November 30, 2026')
    assert.equal(ANNOUNCED_ON, '2026-06-03')
    assert.equal(SOURCE_URL, 'https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object')
  })

  test('counts whole days remaining', () => {
    assert.equal(daysUntilShutdown(new Date('2026-08-06T00:00:00Z')), 116)
    assert.equal(daysUntilShutdown(new Date('2026-11-29T00:00:00Z')), 1)
    assert.equal(daysUntilShutdown(new Date('2026-11-29T23:59:00Z')), 1, 'a partial day still counts')
  })

  test('goes to zero and then negative once passed', () => {
    assert.equal(daysUntilShutdown(new Date('2026-11-30T00:00:00Z')), 0)
    assert.equal(daysUntilShutdown(new Date('2026-12-05T00:00:00Z')), -5)
    assert.equal(isPastShutdown(new Date('2026-11-29T23:00:00Z')), false)
    assert.equal(isPastShutdown(new Date('2026-12-01T00:00:00Z')), true)
  })

  test('the countdown line reads correctly on both sides of the date', () => {
    assert.equal(countdownLine(new Date('2026-08-06T00:00:00Z')), '116 days until v1/prompts shuts down (November 30, 2026).')
    assert.equal(countdownLine(new Date('2026-11-29T06:00:00Z')), '1 day until v1/prompts shuts down (November 30, 2026).')
    assert.equal(countdownLine(new Date('2026-11-30T00:00:00Z')), 'v1/prompts shuts down today (November 30, 2026).')
    assert.match(countdownLine(new Date('2026-12-02T00:00:00Z')), /^v1\/prompts shut down 2 days ago .*Capture no longer works; the resolver still does\.$/)
  })
})
