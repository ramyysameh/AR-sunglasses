import { authenticate } from '../shopify.server'
import db from '../db.server'
import { applySubscriptionUpdate } from '../billing.server'
import { syncStorefrontAccess } from '../tryonMetafield.server'

// Shopify fires app_subscriptions/update on subscribe, upgrade, downgrade,
// cancel, and payment failure. It is the authoritative source that keeps the
// local ShopSubscription row current for the edge-cached storefront path.
export const action = async ({ request }) => {
  const { payload, shop, admin } = await authenticate.webhook(request)
  const sub = payload?.app_subscription
  if (sub && shop) {
    const row = await applySubscriptionUpdate(
      db,
      shop,
      { name: sub.name ?? null, status: sub.status },
      new Date(),
    )
    // Tell the theme block when to stop showing Try on (the end of grace), or
    // clear that once the plan is active again. `admin` is absent when the shop
    // has no offline session (e.g. already uninstalled, when the block is gone
    // anyway). Logged, not thrown: the local row above is already right, and a
    // redelivery would recompute the same value.
    if (admin) {
      try {
        await syncStorefrontAccess(admin, row.graceEndsAt)
      } catch (e) {
        console.error('storefront access sync failed', e)
      }
    }
  }
  return new Response()
}
