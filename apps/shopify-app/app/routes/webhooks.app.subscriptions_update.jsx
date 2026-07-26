import { authenticate } from '../shopify.server'
import db from '../db.server'
import { applySubscriptionUpdate } from '../billing.server'

// Shopify fires app_subscriptions/update on subscribe, upgrade, downgrade,
// cancel, and payment failure. It is the authoritative source that keeps the
// local ShopSubscription row current for the edge-cached storefront path.
export const action = async ({ request }) => {
  const { payload, shop } = await authenticate.webhook(request)
  const sub = payload?.app_subscription
  if (sub && shop) {
    await applySubscriptionUpdate(
      db,
      shop,
      { name: sub.name ?? null, status: sub.status },
      new Date(),
    )
  }
  return new Response()
}
