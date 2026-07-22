import db from '../db.server'
import { registerModelByUrl } from '../models.server'

// Public: the hosted engine (theme iframe) calls this cross-origin with a
// merchant's Shopify-Files GLB URL. We calibrate + cache it once (keyed by the
// URL) and return the served model URL + fit metadata. No admin auth this slice
// — same posture as api.tryon-config. See plan Global Constraints.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

export const loader = async ({ request }) => {
  const url = new URL(request.url)
  const modelUrl = url.searchParams.get('url')
  const shop = url.searchParams.get('shop')
  if (!modelUrl || !/^https:\/\//i.test(modelUrl)) {
    return Response.json({ error: 'a valid https url is required' }, { status: 400, headers: CORS })
  }
  // Required so the resulting ModelAsset is attributable and therefore
  // erasable by shop/redact. The engine always has this — the theme block
  // passes shop.permanent_domain into the iframe URL.
  if (!shop) {
    return Response.json({ error: 'shop is required' }, { status: 400, headers: CORS })
  }
  try {
    const cfg = await registerModelByUrl(db, modelUrl, shop)
    return Response.json(cfg, { headers: CORS })
  } catch (err) {
    const message = err?.message ?? 'registration failed'
    const status = /^fetch failed/i.test(message) ? 502 : 422
    return Response.json({ error: message }, { status, headers: CORS })
  }
}
