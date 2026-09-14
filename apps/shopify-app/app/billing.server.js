// Managed Pricing: plan NAMES + product limits are the only billing facts in
// code. Prices and the 7-day trial live in the Partner Dashboard. The names
// here MUST match the dashboard plan names exactly, or planLimit() fails closed.
export const PLAN_LIMITS = { Starter: 10, Growth: 40, Pro: Infinity }

// Days the storefront try-on keeps serving after a subscription lapses.
export const GRACE_PERIOD_DAYS = 7

// Owner-comped shops: the app owner's own stores get full, free access with no
// Shopify subscription. Managed Pricing has no per-store comp and no free tier,
// so this is enforced in code. Matched against the myshopify domain (session.shop
// in admin, the `shop` query param on the storefront). Set FREE_ACCESS_SHOPS to a
// comma-separated list of myshopify domains to override; the default covers the
// Gripz store. A comped shop is treated as the top (Pro / unlimited) plan.
const FREE_ACCESS_SHOPS = new Set(
  // eslint-disable-next-line no-undef
  (process.env.FREE_ACCESS_SHOPS || 'xmcjg8-uh.myshopify.com')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
)

// Time-boxed comps -- an "extended free trial" for one store. Managed Pricing
// has no per-store trial override, and appSubscriptionTrialExtend only works
// while a trial is still running (it returns TRIAL_NOT_ACTIVE once the trial
// lapses), so a trial that already ended can only be extended here. Format:
//   FREE_ACCESS_UNTIL="shop.myshopify.com:2026-10-15,other.myshopify.com:2026-11-30"
// The date is the LAST day of free access, inclusive, UTC. Malformed entries
// are dropped: a typo must deny access, never grant it.
export function parseFreeAccessUntil(spec) {
  return new Map(
    (spec || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const at = entry.lastIndexOf(':')
        if (at < 1) return null
        const shop = entry.slice(0, at).trim().toLowerCase()
        const until = new Date(`${entry.slice(at + 1).trim()}T23:59:59.999Z`)
        return shop && !Number.isNaN(until.getTime()) ? [shop, until] : null
      })
      .filter(Boolean),
  )
}

// eslint-disable-next-line no-undef
const FREE_ACCESS_UNTIL = parseFreeAccessUntil(process.env.FREE_ACCESS_UNTIL)

/**
 * Whether a shop is comped (free, unlimited access, no subscription): either
 * permanently (FREE_ACCESS_SHOPS) or through a date (FREE_ACCESS_UNTIL).
 * @param {string|null|undefined} shop myshopify domain
 * @param {Date} [now] evaluation time, for the time-boxed comps
 * @returns {boolean}
 */
export function hasFreeAccess(shop, now = new Date()) {
  if (!shop) return false
  const key = shop.toLowerCase()
  if (FREE_ACCESS_SHOPS.has(key)) return true
  const until = FREE_ACCESS_UNTIL.get(key)
  return Boolean(until) && now <= until
}

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
 * @param {string|null} [shop] myshopify domain, for the owner-comp short-circuit
 * @returns {Promise<string|null>}
 */
export async function getActivePlanName(admin, shop = null) {
  // Owner-comped stores skip the live Shopify check and read as the top plan.
  if (hasFreeAccess(shop)) return 'Pro'
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
 * @param {string|null} [shop] myshopify domain, for the owner-comp short-circuit
 * @returns {Promise<{error: string}|null>} error object, or null if active
 */
export async function requireActivePlanForAction(admin, shop = null) {
  const activePlan = await getActivePlanName(admin, shop)
  if (!activePlan) {
    return { error: 'No active subscription. Choose a plan to continue.' }
  }
  return null
}

/**
 * Managed Pricing page for a shop. Not embeddable -- callers must open it
 * top-level (target="_top"), never inside the app iframe.
 * @param {string} shop myshopify domain
 * @returns {string}
 */
export function pricingUrlFor(shop) {
  const store = String(shop).replace(/\.myshopify\.com$/, '')
  // eslint-disable-next-line no-undef
  const handle = process.env.SHOPIFY_APP_HANDLE || ''
  return `https://admin.shopify.com/store/${store}/charges/${handle}/pricing_plans`
}
