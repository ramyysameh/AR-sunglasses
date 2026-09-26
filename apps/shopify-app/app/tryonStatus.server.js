// The one place that decides what a merchant is told about a product. Pure, and
// deliberately the only module allowed to turn pipeline state into merchant
// words -- Home and Products must never read `status` or `confidence` directly.

// Below this, the geometric fit is uncertain enough that a merchant should look
// at it before trusting the result on a customer's face.
export const LOW_CONFIDENCE = 0.6

/**
 * Whether a model asset's fit needs a merchant's review before it's trusted
 * on a customer's face. The single source for that predicate -- productStatus
 * below folds it into `check_fit` for the Products surface, and the Models
 * loader (app/routes/app.models.jsx) reuses this directly, so "ready but low
 * confidence" can never read as "needs review" on one surface and "Ready" on
 * the other. Exported standalone (not just embedded in productStatus)
 * because the Models loader has a bare asset, not a `{ mapping }` with
 * `lastSeenLiveAt` -- it has no use for the rest of productStatus's shape.
 *
 * Once the merchant reviews the fit and accepts it (`fitReviewedAt`), the
 * question is answered and the model no longer needs review. The storefront
 * serves the model either way; this only drives what the admin asks for.
 * @param {{ status: string, confidence?: number|null, fitReviewedAt?: Date|string|null }} asset
 * @returns {boolean}
 */
export function needsFitReview(asset) {
  if (asset.fitReviewedAt) return false
  const lowConfidence = typeof asset.confidence === 'number' && asset.confidence < LOW_CONFIDENCE
  return asset.status !== 'ready' || lowConfidence
}

/**
 * Whether the try-on button is actually on the merchant's storefront.
 *
 * `blockSeenAt` is the direct signal: the theme block reports itself once it
 * has rendered on a product page. `lastSeenLiveAt` counts too, and is what
 * makes this correct for mappings that predate blockSeenAt -- a shopper cannot
 * have opened the try-on unless the block was there to open it.
 * @param {{ blockSeenAt?: Date|null, lastSeenLiveAt?: Date|null }} mapping
 * @returns {boolean}
 */
export function isOnTheme(mapping) {
  return Boolean(mapping.blockSeenAt || mapping.lastSeenLiveAt)
}

/**
 * @param {{ blockSeenAt?: Date|null, lastSeenLiveAt: Date|null, modelAsset: { status: string, confidence?: number|null } }} mapping
 * @returns {{ id: 'check_fit'|'not_on_theme'|'live', label: string, tone: 'warning'|'success' }}
 */
export function productStatus(mapping) {
  const asset = mapping.modelAsset ?? {}

  // Order is load-bearing; see the precedence test. The id stays `check_fit`
  // (the workspace's status filter/sort keys off it) -- only the merchant-facing
  // label changed, to match the action every "review this" surface now
  // offers (ModelFitReview via the Models review modal and the product
  // preview panel).
  if (needsFitReview(asset)) {
    return { id: 'check_fit', label: 'Review fit', tone: 'warning' }
  }
  // Keyed on isOnTheme, not on lastSeenLiveAt. Those are different questions:
  // the button's engine iframe sits in a closed <dialog> and is lazy, so
  // lastSeenLiveAt only moves when a shopper CLICKS try-on. Keying "Not on your
  // theme yet" off it told correctly-set-up merchants they had not finished,
  // which pushed them into following "Add to theme" a second time -- and that
  // deep link adds another copy of the block every time it is followed.
  if (!isOnTheme(mapping)) {
    return { id: 'not_on_theme', label: 'Not on your theme yet', tone: 'warning' }
  }
  return { id: 'live', label: 'Live', tone: 'success' }
}
