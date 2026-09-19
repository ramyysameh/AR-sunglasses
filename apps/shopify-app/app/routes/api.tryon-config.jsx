import db from '../db.server'
import { getTryonConfig, recordTryonSeen } from '../tryonConfig.server'
import { getShopSubscription, isServable, hasFreeAccess } from '../billing.server'

// Public endpoint: the hosted engine (inside the theme iframe) fetches this to
// learn its model URL + fit-metadata for a given shop+product.
//
// No CORS headers: the engine is served from this app and issues relative
// requests, so this is same-origin. The theme block makes no network calls of
// its own -- verified the extension contains no fetch/XHR.
//
// Left unauthenticated deliberately. NOTE the reason is NOT "unguessable id":
// this is keyed by (shop, productId), both of which are guessable, and it hands
// out the asset UUID. It is open because it returns the same public product
// data any storefront visitor already receives by opening the try-on on that
// product page. If it ever returns anything non-public, revisit this.
// A database read failed for reasons that have nothing to do with this product.
// 503 is the honest answer: 500 reports a bug in this app and pollutes error
// monitoring, and 404 would tell the engine "this product has no try-on" -- a
// permanent-sounding claim that would hide a working try-on button until the
// next page load. Retry-After invites the caller back rather than giving up.
//
// Seen in production as PrismaClientInitializationError, "Timed out fetching a
// new connection from the connection pool (connection limit: 1)". The runtime
// pool is deliberately one connection (see the datasource comment in
// prisma/schema.prisma), so concurrent storefront requests hitting one warm
// lambda -- or any request arriving while the database is cold -- can exhaust
// it and time out after 10s.
function unavailable(reason, error) {
  console.error(`tryon-config: ${reason}`, error)
  return new Response('try-on is temporarily unavailable', {
    status: 503,
    headers: { 'Retry-After': '5' },
  })
}

export const loader = async ({ request }) => {
  const url = new URL(request.url)
  const shop = url.searchParams.get('shop')
  const productId = url.searchParams.get('productId')
  if (!shop || !productId) {
    return new Response('shop and productId required', { status: 400 })
  }
  // Billing gate: a paid feature. Read only the local row (webhook-updated) so
  // this edge-cached path never calls Shopify. Grace is evaluated at read time.
  // Owner-comped shops serve without a subscription row; everyone else needs an
  // active (or in-grace) subscription.
  if (!hasFreeAccess(shop)) {
    let sub
    try {
      sub = await getShopSubscription(db, shop)
    } catch (e) {
      // Deliberately not falling open to "servable": that would serve a paid
      // feature to a lapsed shop whenever the database hiccups.
      return unavailable('subscription lookup failed', e)
    }
    if (!isServable(sub, new Date())) {
      return new Response('subscription required', { status: 402 })
    }
  }
  let cfg
  try {
    cfg = await getTryonConfig(db, shop, productId)
  } catch (e) {
    return unavailable('config lookup failed', e)
  }
  if (!cfg) return new Response('not found', { status: 404 })
  // Proof of life: reaching here means the block is installed, the product is
  // mapped, and the subscription is servable. Merchant previews carry
  // src=preview and are excluded -- otherwise previewing your own product would
  // report a theme block that was never installed.
  if (url.searchParams.get('src') !== 'preview') {
    try {
      await recordTryonSeen(db, shop, productId)
    } catch (e) {
      // Never fail the storefront's config fetch over a bookkeeping write.
      console.error('recordTryonSeen failed', e)
    }
  }
  return Response.json(cfg)
}
