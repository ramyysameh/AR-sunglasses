// Shopify app-block deep links use the app API key/client ID, not the theme
// extension uid. The latter used to be accepted but now produces the generic
// "block not added" editor error. Keep this aligned with shopify.app.toml.
const CANONICAL_API_KEY = 'be1db9d64c7c617dcd67f6add58f4824'
const BLOCK_HANDLE = 'tryon_button'

function apiKey() {
  // Do not read SHOPIFY_API_KEY here. Some development/deployment environments
  // still carry the retired f2a93e app's credential; using it creates a valid-
  // looking deep link for the wrong app and Shopify rejects the block.
  return CANONICAL_API_KEY
}

/**
 * Deep link to the theme editor with the try-on block pre-inserted into the
 * product template. Not embeddable: open top-level (target="_top"), the same
 * reason app.jsx opens the Managed Pricing URL that way.
 * @param {string} shop myshopify domain
 * @param {string|null} [productHandle] product to preview in the theme editor
 */
export function themeEditorUrl(shop, productHandle = null) {
  const domain = String(shop).replace(/^https?:\/\//, '').replace(/\/$/, '')
  const url = new URL(`https://${domain}/admin/themes/current/editor`)
  if (productHandle) {
    url.searchParams.set('previewPath', `/products/${productHandle}`)
  } else {
    url.searchParams.set('template', 'product')
  }
  url.searchParams.set('addAppBlockId', `${apiKey()}/${BLOCK_HANDLE}`)
  url.searchParams.set('target', 'mainSection')
  return url.toString()
}

/**
 * The try-on engine, pointed at one product. src=preview marks this as merchant
 * traffic so api.tryon-config excludes it from the proof-of-life signal.
 * @param {{ engineUrl: string, shop: string, productId: string, gscale?: number }} input
 */
export function previewUrl({ engineUrl, shop, productId, gscale }) {
  const url = new URL(engineUrl)
  url.searchParams.set('shop', shop)
  url.searchParams.set('productId', productId)
  url.searchParams.set('src', 'preview')
  if (gscale != null) url.searchParams.set('gscale', String(gscale))
  return url.toString()
}
