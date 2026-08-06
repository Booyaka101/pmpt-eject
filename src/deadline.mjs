/**
 * The one date this whole package exists for.
 *
 * Source: https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object
 *   "v1/prompts is scheduled to shut down on November 30, 2026."
 *
 * Announced 2026-06-03 in the deprecations table alongside Agent Builder and the
 * Evals platform; prompts were the only one of the three given no export path —
 * the sanctioned migration is "Move the prompt content out of the managed prompt
 * object and into your application code."
 */

/** Shutdown instant, UTC. */
export const SHUTDOWN_ISO = '2026-11-30T00:00:00.000Z'

/** Human spelling used in OpenAI's own docs. */
export const SHUTDOWN_LABEL = 'November 30, 2026'

/** Date the deprecation was announced. */
export const ANNOUNCED_ON = '2026-06-03'

/** Primary migration guide. */
export const SOURCE_URL =
  'https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object'

/** The dated deprecations table. */
export const DEPRECATIONS_URL = 'https://developers.openai.com/api/docs/deprecations'

const DAY_MS = 86_400_000

/**
 * Whole days remaining until the shutdown instant.
 * Rounds up, so the last partial day still counts as a day.
 * Returns 0 or a negative number once the deadline has passed.
 *
 * @param {Date} [now]
 * @returns {number}
 */
export function daysUntilShutdown(now = new Date()) {
  const ms = Date.parse(SHUTDOWN_ISO) - now.getTime()
  return ms <= 0 ? Math.floor(ms / DAY_MS) : Math.ceil(ms / DAY_MS)
}

/** @param {Date} [now] */
export function isPastShutdown(now = new Date()) {
  return Date.parse(SHUTDOWN_ISO) - now.getTime() <= 0
}

/**
 * One-line countdown suitable for a banner.
 * @param {Date} [now]
 */
export function countdownLine(now = new Date()) {
  const days = daysUntilShutdown(now)
  if (days > 1) return `${days} days until v1/prompts shuts down (${SHUTDOWN_LABEL}).`
  if (days === 1) return `1 day until v1/prompts shuts down (${SHUTDOWN_LABEL}).`
  if (days === 0) return `v1/prompts shuts down today (${SHUTDOWN_LABEL}).`
  return `v1/prompts shut down ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago (${SHUTDOWN_LABEL}). Capture no longer works; the resolver still does.`
}
