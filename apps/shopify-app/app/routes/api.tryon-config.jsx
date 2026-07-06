import db from '../db.server'
import { getTryonConfig } from '../tryonConfig.server'

// Public endpoint: the hosted engine (inside the theme iframe) fetches this
// cross-origin to learn its model URL + fit-metadata for a given shop+product.
// No access control this slice (unguessable UUIDs only) — see plan Global Constraints.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

export const loader = async ({ request }) => {
  const url = new URL(request.url)
  const shop = url.searchParams.get('shop')
  const productId = url.searchParams.get('productId')
  if (!shop || !productId) {
    return new Response('shop and productId required', { status: 400, headers: CORS })
  }
  const cfg = await getTryonConfig(db, shop, productId)
  if (!cfg) return new Response('not found', { status: 404, headers: CORS })
  return Response.json(cfg, { headers: CORS })
}
