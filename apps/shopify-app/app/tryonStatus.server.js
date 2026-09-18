// The one place that decides what a merchant is told about a product. Pure, and
// deliberately the only module allowed to turn pipeline state into merchant
// words -- Home and Products must never read `status` or `confidence` directly.

// Below this, the geometric fit is uncertain enough that a merchant should look
// at it before trusting the result on a customer's face.
export const LOW_CONFIDENCE = 0.6

/**
 * @param {{ lastSeenLiveAt: Date|null, modelAsset: { status: string, confidence?: number|null } }} mapping
 * @returns {{ id: 'check_fit'|'not_on_theme'|'live', label: string, tone: 'warning'|'success' }}
 */
export function productStatus(mapping) {
  const asset = mapping.modelAsset ?? {}
  const lowConfidence = typeof asset.confidence === 'number' && asset.confidence < LOW_CONFIDENCE

  // Order is load-bearing; see the precedence test. The id stays `check_fit`
  // (ProductIndex.jsx's filter/sort keys off it) -- only the merchant-facing
  // label changed, to match the action every "review this" surface now
  // offers (ModelFitReview via the Models review modal and the product
  // preview panel).
  if (asset.status !== 'ready' || lowConfidence) {
    return { id: 'check_fit', label: 'Review fit', tone: 'warning' }
  }
  if (!mapping.lastSeenLiveAt) {
    return { id: 'not_on_theme', label: 'Not on your theme yet', tone: 'warning' }
  }
  return { id: 'live', label: 'Live', tone: 'success' }
}
