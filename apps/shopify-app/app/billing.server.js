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

const ACTIVE_SUBSCRIPTIONS_QUERY = `#graphql
  query ActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions { name status }
    }
  }`

/**
 * The name of the shop's ACTIVE subscription, read live from Shopify in admin
 * context. Returns null if there is no active subscription. Admin-only — never
 * call from the storefront path (it makes a live API call).
 * @param {{graphql: (q: string) => Promise<Response>}} admin
 * @returns {Promise<string|null>}
 */
export async function getActivePlanName(admin) {
  const res = await admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY)
  const body = await res.json()
  const subs = body?.data?.currentAppInstallation?.activeSubscriptions ?? []
  const active = subs.find((s) => s.status === 'ACTIVE')
  return active?.name ?? null
}

/**
 * Guard for admin ACTIONS. Actions can't use the top-level break-out
 * redirect a loader can, so this returns the same {error} shape the route
 * already renders instead of throwing.
 * @param {{graphql: (q: string) => Promise<Response>}} admin
 * @returns {Promise<{error: string}|null>} error object, or null if active
 */
export async function requireActivePlanForAction(admin) {
  const activePlan = await getActivePlanName(admin)
  if (!activePlan) {
    return { error: 'No active subscription. Choose a plan to continue.' }
  }
  return null
}
