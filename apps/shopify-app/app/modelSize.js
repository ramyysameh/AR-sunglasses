// The per-model size slider on each Models card. Same span as the theme block's
// "Glasses size" setting (0.5-2.5x) so the two read alike, with a finer step:
// this one tunes a single model on top of that store-wide value. The engine
// multiplies the two together, so 1 leaves a model's automatic fit unchanged.
// Shared by the card (client) and the action that saves it (server).
export const MODEL_SIZE_MIN = 0.5
export const MODEL_SIZE_MAX = 2.5
export const MODEL_SIZE_STEP = 0.05
export const MODEL_SIZE_DEFAULT = 1

/**
 * A submitted size, snapped to the slider's step, or null when it is not a
 * number inside the range. Out-of-range values are refused rather than clamped:
 * a clamped save would quietly differ from what the merchant chose.
 * @param {unknown} raw
 * @returns {number | null}
 */
export function parseModelSize(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value < MODEL_SIZE_MIN || value > MODEL_SIZE_MAX) return null
  return Number((Math.round(value / MODEL_SIZE_STEP) * MODEL_SIZE_STEP).toFixed(2))
}

/**
 * What a released slider should save: the snapped size, or null when there is
 * nothing to save (an unparseable value, or the thumb let go where it started).
 * @param {unknown} raw
 * @param {number} saved
 * @returns {number | null}
 */
export function sizeToSubmit(raw, saved) {
  const size = parseModelSize(raw)
  return size === null || size === saved ? null : size
}

/** "1×", "1.25×", "1.5×" -- no trailing zeros. */
export function formatModelSize(value) {
  return `${Number(Number(value).toFixed(2))}×`
}
