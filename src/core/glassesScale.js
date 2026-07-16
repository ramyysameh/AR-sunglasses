// Global glasses-size fine-tune. A portrait viewport (phone, or the storefront
// dialog) crops the landscape camera (object-fit:cover), zooming the face without
// zooming the glasses; this multiplier compensates. ?gscale=<n> overrides for
// live tuning. Landscape (full-screen desktop) needs no compensation → 1.0.
// Value from on-device tuning on a real phone.
const PORTRAIT_SCALE = 1.55

export function resolveGlassesScaleMultiplier(search, isPortrait) {
  const override = parseFloat(new URLSearchParams(search).get('gscale'))
  if (Number.isFinite(override) && override > 0) {
    return override
  }
  return isPortrait ? PORTRAIT_SCALE : 1
}
