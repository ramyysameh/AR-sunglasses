// The uid committed in extensions/tryon-button/shopify.extension.toml. Override
// with SHOPIFY_THEME_EXTENSION_UID if the deployed registration id turns out to
// differ from the CLI uid -- see the spec's risk note.
const FALLBACK_EXTENSION_UID = '53b5dfb4-3bb4-0954-72aa-7e751170befc5b13a1dd'
const BLOCK_HANDLE = 'tryon_button'

function extensionUid() {
  // eslint-disable-next-line no-undef
  return process.env.SHOPIFY_THEME_EXTENSION_UID || FALLBACK_EXTENSION_UID
}

/**
 * Deep link to the theme editor with the try-on block pre-inserted into the
 * product template. Not embeddable: open top-level (target="_top"), the same
 * reason app.jsx opens the Managed Pricing URL that way.
 * @param {string} shop myshopify domain
 * @param {string|null} [productHandle] product to preview in the theme editor
 */
export function themeEditorUrl(shop, productHandle = null) {
  const store = String(shop).replace(/\.myshopify\.com$/, '')
  const url = new URL(`https://admin.shopify.com/store/${store}/themes/current/editor`)
  url.searchParams.set('template', 'product')
  if (productHandle) {
    url.searchParams.set('previewPath', `/products/${productHandle}`)
  }
  url.searchParams.set('addAppBlockId', `${extensionUid()}/${BLOCK_HANDLE}`)
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
