// Lens reflection tuning. Defaults are baked from on-device tuning; the URL
// params exist to re-tune on a real phone, exactly like ?gscale and ?voffset.
const DEFAULTS = {
  // Above 1 on purpose: the loader forces lens opacity to ~0.62 and alpha
  // blending scales the whole fragment, so intensity 1 arrives pre-dimmed.
  intensity: 1.8,
  // Roughness floor. Smoke_Lens is authored at 0 (perfect mirror), which makes
  // the sun a hard aliased dot; a little roughness blooms it into a glint.
  roughness: 0.06,
  sunAzimuthDeg: 35,
  sunElevationDeg: 28,
}

function resolveParam(search, key, fallback, isValid) {
  const raw = parseFloat(new URLSearchParams(search).get(key))
  return Number.isFinite(raw) && isValid(raw) ? raw : fallback
}

export function resolveLensReflectionConfig(search) {
  return {
    intensity: resolveParam(search, 'lensrefl', DEFAULTS.intensity, (v) => v >= 0),
    roughness: resolveParam(search, 'lensrough', DEFAULTS.roughness, (v) => v >= 0 && v <= 1),
    sunAzimuthDeg: resolveParam(search, 'sunaz', DEFAULTS.sunAzimuthDeg, () => true),
    sunElevationDeg: resolveParam(search, 'sunel', DEFAULTS.sunElevationDeg, (v) => v >= -90 && v <= 90),
  }
}

/**
 * Applies the reflection to ONE lens material. Never call this for a frame
 * material: the frame is deliberately excluded (see 2e12c0f — glossy frame
 * specular read as a distracting white glare).
 */
export function applyLensReflection(material, envMap, config) {
  if (!material || !envMap) {
    return
  }

  material.envMap = envMap
  material.envMapIntensity = config.intensity

  if ('roughness' in material && material.roughness < config.roughness) {
    material.roughness = config.roughness
  }
}
