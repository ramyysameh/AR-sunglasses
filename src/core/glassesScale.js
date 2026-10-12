// Global glasses-size fine-tune. Historically this multiplied in an extra
// factor for "portrait" containers (phone, storefront dialog) to compensate
// for object-fit:cover cropping the display. That was a symptom patch: the
// real bug was in FaceFitSolver's world-size math using the DISPLAY
// container's aspect ratio instead of the camera's own native resolution,
// making the computed face width -- and therefore fit scale -- drift with
// whatever box the try-on happened to render in. With that fixed at the
// source (FaceFitSolver.js: anchorToMetricXY/estimateMetricDepth), fit scale
// is already device/container-independent, so no orientation-based
// compensation is needed here. ?gscale=<n> remains as a manual override for
// one-off tuning/preference, independent of that fix.
export function resolveGlassesScaleMultiplier(search) {
  const override = parseFloat(new URLSearchParams(search).get('gscale'))
  return Number.isFinite(override) && override > 0 ? override : 1
}

// Per-model size the merchant sets on the model's card in the admin, served by
// /api/tryon-config. Stacks with ?gscale (the theme block's store-wide Glasses
// size) rather than replacing it, so 1 leaves a model exactly as it was.
export function resolveModelSizeMultiplier(modelConfig) {
  const size = modelConfig?.sizeMultiplier
  return Number.isFinite(size) && size > 0 ? size : 1
}
