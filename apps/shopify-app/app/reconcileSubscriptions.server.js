import { applySubscriptionUpdate } from './billing.server.js'

// The app_subscriptions/update webhook is the fast path that keeps
// ShopSubscription current. It is not a guarantee: a delivery can be dropped,
// 5xx'd during a deploy, or retried past Shopify's limit, and Shopify does not
// re-send it afterwards. Because isServable() trusts the local row with no
// staleness bound, ONE missed lapse event serves that shop's storefront for
// free forever. This module is the safety net -- it re-reads the truth from
// Shopify and writes it back through the same applySubscriptionUpdate() the
// webhook uses, so reconciled state and webhook state are identical.
//
// This is deliberately NOT called from the storefront path: api.tryon-config
// must stay edge-cacheable and never call Shopify. Run it on a schedule.

const ACTIVE_SUBSCRIPTIONS_QUERY = `#graphql
  query ActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions { name status }
    }
  }`

/**
 * A shop's real ACTIVE subscription per Shopify, using the app's stored offline
 * token. Returns {name, status} or null when the shop has none.
 * @returns {Promise<{name: string, status: string}|null>}
 */
export async function fetchActiveSubscription(
  shop,
  accessToken,
  apiVersion,
  fetchImpl = fetch,
) {
  const res = await fetchImpl(
    `https://${shop}/admin/api/${apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: ACTIVE_SUBSCRIPTIONS_QUERY }),
    },
  )
  // Throw rather than treat a transport failure as "no subscription" -- a 429
  // or 5xx must never be the reason a paying shop gets cut off.
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status} for ${shop}`)
  const body = await res.json()
  const subs = body?.data?.currentAppInstallation?.activeSubscriptions ?? []
  return subs.find((s) => s.status === 'ACTIVE') ?? null
}

/**
 * Reconcile ONE shop's local row against Shopify.
 *
 * A shop with no active subscription AND no local row is skipped: writing one
 * would hand a shop that never subscribed a fresh GRACE_PERIOD_DAYS window,
 * which is the opposite of the point. Comped shops (hasFreeAccess) have no row
 * and are skipped for the same reason -- they bypass this table entirely.
 *
 * @returns {Promise<{shop: string, action: string, before: string|null, after: string|null}>}
 */
export async function reconcileShop(
  prisma,
  shop,
  { accessToken, apiVersion, now = new Date(), fetchImpl } = {},
) {
  const active = await fetchActiveSubscription(
    shop,
    accessToken,
    apiVersion,
    fetchImpl,
  )
  const existing = await prisma.shopSubscription.findUnique({ where: { shop } })
  const before = existing ? `${existing.planName}/${existing.status}` : null

  if (!active && !existing) return { shop, action: 'skipped', before, after: null }

  // Grace for a missed lapse starts at discovery, not at the real lapse time --
  // that timestamp is unrecoverable once the webhook is gone. Erring toward the
  // merchant matches what the webhook itself would have stamped.
  const next = active
    ? { name: active.name, status: 'ACTIVE' }
    : { name: existing?.planName ?? null, status: 'CANCELLED' }

  const row = await applySubscriptionUpdate(prisma, shop, next, now)
  const after = `${row.planName}/${row.status}`
  return {
    shop,
    action: before === after ? 'unchanged' : 'corrected',
    before,
    after,
  }
}

/**
 * Reconcile every installed shop. One shop's failure never aborts the run --
 * a single revoked token must not stop the rest from being corrected.
 * @returns {Promise<Array<object>>} one result per shop, errors included
 */
export async function reconcileAll(
  prisma,
  { apiVersion, now = new Date(), fetchImpl, shops = null } = {},
) {
  const sessions = await prisma.session.findMany({
    select: { shop: true, accessToken: true },
  })
  const seen = new Set()
  const results = []
  for (const s of sessions) {
    if (seen.has(s.shop) || !s.accessToken) continue
    if (shops && !shops.includes(s.shop)) continue
    seen.add(s.shop)
    try {
      results.push(
        await reconcileShop(prisma, s.shop, {
          accessToken: s.accessToken,
          apiVersion,
          now,
          fetchImpl,
        }),
      )
    } catch (err) {
      results.push({ shop: s.shop, action: 'error', error: String(err.message) })
    }
  }
  return results
}
