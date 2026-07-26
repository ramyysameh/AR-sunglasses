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

/**
 * The local subscription row for a shop, or null. Source of truth for the
 * edge-cached storefront path so it never calls Shopify.
 */
export async function getShopSubscription(prisma, shop) {
  return prisma.shopSubscription.findUnique({ where: { shop } })
}

/**
 * Apply an authoritative status update (from the app_subscriptions/update
 * webhook). ACTIVE clears grace; the first non-ACTIVE stamps graceEndsAt =
 * now + GRACE_PERIOD_DAYS and later non-ACTIVE updates preserve it.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} shop
 * @param {{name: string|null, status: string}} sub
 * @param {Date} now
 */
export async function applySubscriptionUpdate(prisma, shop, sub, now) {
  const status = sub.status
  let graceEndsAt = null
  if (status !== 'ACTIVE') {
    const existing = await prisma.shopSubscription.findUnique({ where: { shop } })
    graceEndsAt =
      existing?.graceEndsAt ??
      new Date(now.getTime() + GRACE_PERIOD_DAYS * 24 * 3600 * 1000)
  }
  return prisma.shopSubscription.upsert({
    where: { shop },
    update: { planName: sub.name, status, graceEndsAt },
    create: { shop, planName: sub.name, status, graceEndsAt },
  })
}
