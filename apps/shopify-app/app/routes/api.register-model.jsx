import db from '../db.server'
import { registerModelByUrl } from '../models.server'

// Public: the hosted engine (theme iframe) calls this with a merchant's
// Shopify-Files GLB URL. We calibrate + cache it once (keyed by shop+URL) and
// return the served model URL + fit metadata.
//
// No CORS headers: the engine is served from this app at /tryon/index.html and
// issues relative requests, so these calls are same-origin. The theme block
// itself makes no network calls -- verified that the extension contains no
// fetch/XHR at all. If the block ever gains client-side logic that calls this
// endpoint, it needs App Proxy, NOT a restored wildcard ACAO.

// Errors carry a machine-readable `code`; we map code -> status here and never
// forward err.message. An unrecognised code falls through to 500 so a new throw
// site fails closed instead of leaking whatever it happened to say.
const STATUS_BY_CODE = {
  URL_NOT_ALLOWED: [400, 'model url must be hosted on cdn.shopify.com'],
  SHOP_INVALID: [400, 'invalid request'],
  SHOP_NOT_INSTALLED: [403, 'shop not found'],
  QUOTA_EXCEEDED: [429, 'model limit reached'],
  FETCH_FAILED: [422, 'could not retrieve model'],
  TOO_LARGE: [422, 'could not retrieve model'],
}

export const loader = async ({ request }) => {
  const url = new URL(request.url)
  const modelUrl = url.searchParams.get('url')
  const shop = url.searchParams.get('shop')

  if (!modelUrl || !shop) {
    return Response.json({ error: 'invalid request' }, { status: 400 })
  }

  try {
    return Response.json(await registerModelByUrl(db, modelUrl, shop))
  } catch (error) {
    const [status, message] = STATUS_BY_CODE[error?.code] ?? [500, 'registration failed']
    console.error(
      JSON.stringify({
        event: 'register_model_failed',
        code: error?.code ?? 'UNCODED',
        shop,
        detail: error?.message,
        at: new Date().toISOString(),
      }),
    )
    return Response.json({ error: message }, { status })
  }
}
