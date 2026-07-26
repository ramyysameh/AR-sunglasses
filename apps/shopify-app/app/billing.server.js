// Managed Pricing: plan NAMES + product limits are the only billing facts in
// code. Prices and the 7-day trial live in the Partner Dashboard. The names
// here MUST match the dashboard plan names exactly, or planLimit() fails closed.
export const PLAN_LIMITS = { Starter: 10, Growth: 40, Pro: Infinity }

// Days the storefront try-on keeps serving after a subscription lapses.
export const GRACE_PERIOD_DAYS = 7

/**
 * Product cap for a plan name. Unknown/missing name -> 0 (fail closed): a
 * dashboard/code name mismatch must block, never unlock.
 * @param {string|null|undefined} name
 * @returns {number}
 */
export function planLimit(name) {
  return Object.prototype.hasOwnProperty.call(PLAN_LIMITS, name)
    ? PLAN_LIMITS[name]
    : 0
}

/**
 * Whether the storefront try-on should serve for a shop's local subscription
 * row. True when ACTIVE, or lapsed but still inside the grace window.
 * @param {{status: string, graceEndsAt: Date|null}|null|undefined} sub
 * @param {Date} now
 * @returns {boolean}
 */
export function isServable(sub, now) {
  if (!sub) return false
  if (sub.status === 'ACTIVE') return true
  return Boolean(sub.graceEndsAt) && now < sub.graceEndsAt
}
