// Global glasses-size fine-tune. A portrait phone crops the landscape camera
// (object-fit:cover), zooming the face without zooming the glasses; a ~1.7
// multiplier compensates. ?gscale=<n> overrides for live tuning. Landscape
// needs no compensation, so it defaults to 1.0. Value from on-device tuning.
const PORTRAIT_SCALE = 1.7

export function resolveGlassesScaleMultiplier(search, isPortrait) {
  const override = parseFloat(new URLSearchParams(search).get('gscale'))
  if (Number.isFinite(override) && override > 0) {
    return override
  }
  return isPortrait ? PORTRAIT_SCALE : 1
}
