/**
 * Loads a shop+product's try-on config (model URL + fit metadata) from the app.
 *
 * Never falls back to a bundled frame. Before this existed, every failure --
 * a lapsed subscription (402), an unmapped product (404), a brief database
 * outage (503) -- quietly swapped in the demo sunglasses, so a shopper could
 * try on glasses that were not the product on the page. Now a failure is an
 * error the page shows instead, and only the retryable ones offer Try again.
 */

export const UNAVAILABLE_MESSAGE = "Try-on isn't available for this product right now."
export const RETRY_MESSAGE = "We couldn't load the try-on. Check your connection and try again."

/**
 * @param {string} message
 * @param {boolean} recoverable
 */
function configError(message, recoverable) {
  const error = /** @type {Error & { recoverable: boolean }} */ (new Error(message))
  error.recoverable = recoverable
  return error
}

/**
 * Whether a fit-metadata payload has what the engine needs to place a frame.
 * @param {any} payload
 */
export function isValidConfigPayload(payload) {
  const fitMetadata = payload?.fitMetadata
  return Boolean(payload?.modelUrl) &&
    Boolean(fitMetadata) &&
    typeof fitMetadata === 'object' &&
    Number.isFinite(fitMetadata.frameWidthMeters) &&
    Boolean(fitMetadata.bridgeAnchor) &&
    Boolean(fitMetadata.leftHinge) &&
    Boolean(fitMetadata.rightHinge)
}

/**
 * @param {{ shop: string, productId: string, src?: string, fetchImpl?: typeof fetch }} input
 * @returns {Promise<{ modelUrl: string, fitMetadata: object }>}
 * @throws {Error & { recoverable: boolean }}
 */
export async function fetchRemoteConfig({ shop, productId, src, fetchImpl = fetch }) {
  const srcParam = src ? `&src=${encodeURIComponent(src)}` : ''
  const url = `/api/tryon-config?shop=${encodeURIComponent(shop)}&productId=${encodeURIComponent(productId)}${srcParam}`

  let response
  try {
    response = await fetchImpl(url)
  } catch (error) {
    console.warn('tryon-config request failed:', error)
    throw configError(RETRY_MESSAGE, true)
  }

  // 402 (no active plan) and 404 (no model mapped) are answers, not faults:
  // retrying cannot change them. Anything else (503, 5xx) may pass.
  if (response.status === 402 || response.status === 404) {
    throw configError(UNAVAILABLE_MESSAGE, false)
  }
  if (!response.ok) {
    console.warn(`tryon-config request failed with status ${response.status}`)
    throw configError(RETRY_MESSAGE, true)
  }

  let payload
  try {
    payload = await response.json()
  } catch {
    throw configError(RETRY_MESSAGE, true)
  }
  if (!isValidConfigPayload(payload)) {
    console.warn('invalid tryon-config payload')
    throw configError(UNAVAILABLE_MESSAGE, false)
  }
  return { modelUrl: payload.modelUrl, fitMetadata: payload.fitMetadata }
}
