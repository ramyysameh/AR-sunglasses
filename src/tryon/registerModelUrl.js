/**
 * Builds the register-model request URL.
 *
 * `shop` is required: the app stores the resulting ModelAsset under it so that
 * shop/redact can erase the merchant's block models. Registering without one
 * would create a row no redaction could ever find.
 */
export function buildRegisterModelUrl(modelUrl, shop) {
  if (!shop) {
    throw new Error('buildRegisterModelUrl: shop is required')
  }
  return `/api/register-model?url=${encodeURIComponent(modelUrl)}&shop=${encodeURIComponent(shop)}`
}
