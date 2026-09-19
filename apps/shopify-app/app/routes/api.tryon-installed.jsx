import db from '../db.server'
import { recordBlockInstalled } from '../tryonConfig.server'

// Public endpoint: the theme block pings this once it has rendered the try-on
// button on a storefront product page. That is the only way this app can learn
// the block is installed -- the button's engine iframe lives in a closed
// <dialog> and is lazy, so nothing else is fetched until a shopper clicks.
//
// Unauthenticated for the same reason as api.tryon-config: it is keyed by
// (shop, productId), both public, and it returns nothing. Unlike that route it
// is not behind the billing gate -- refusing to record setup progress for a
// lapsed shop would only make the admin lie about the merchant's own theme,
// and the storefront gate stays where it belongs, on the config route.
//
// Writes nothing a caller can read back and is throttled to one write per
// mapping per hour, so a flood of product-page views cannot turn this into a
// write amplifier on the storefront's hot path.
export const loader = async ({ request }) => {
  const url = new URL(request.url)
  const shop = url.searchParams.get('shop')
  const productId = url.searchParams.get('productId')
  if (!shop || !productId) {
    return new Response(null, { status: 400 })
  }

  try {
    await recordBlockInstalled(db, shop, productId)
  } catch (e) {
    // Best-effort by contract. A database blip must never surface on a
    // shopper's product page, and there is nothing for the caller to retry:
    // the next product view records it.
    console.error('recordBlockInstalled failed', e)
  }

  // 204 regardless: the block does not read the result, and an error status
  // would put a console error on the merchant's storefront for a signal that
  // is purely bookkeeping.
  return new Response(null, { status: 204 })
}
