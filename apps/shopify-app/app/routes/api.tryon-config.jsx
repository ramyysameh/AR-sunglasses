import db from '../db.server'
import { getTryonConfig } from '../tryonConfig.server'

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
export const loader = async ({ request }) => {
  const url = new URL(request.url)
  const shop = url.searchParams.get('shop')
  const productId = url.searchParams.get('productId')
  if (!shop || !productId) {
    return new Response('shop and productId required', { status: 400 })
  }
  const cfg = await getTryonConfig(db, shop, productId)
  if (!cfg) return new Response('not found', { status: 404 })
  return Response.json(cfg)
}
