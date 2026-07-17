// Lens reflection tuning. Defaults are baked from on-device tuning; the URL
// params exist to re-tune on a real phone, exactly like ?gscale and ?voffset.
const DEFAULTS = {
  // Above 1 on purpose: the loader forces lens opacity to ~0.62 and alpha
  // blending scales the whole fragment, so intensity 1 arrives pre-dimmed.
  intensity: 1.8,
  // Roughness floor. Smoke_Lens is authored at 0 (perfect mirror), which makes
  // the sun a hard aliased dot; a little roughness blooms it into a glint.
  roughness: 0.06,
  // Caught at ~17.5deg of head yaw: a yawing lens sweeps the reflected azimuth at
  // 2x the head turn, so the glint hits at half this angle.
  sunAzimuthDeg: 35,
  // Must stay near 0 — the reflected ray off a lens facing the camera is pinned to
  // the elevation-0 ring at any yaw, so a higher sun is simply never reflected. See
  // the sunElevationDeg note in skyTexture.js. ?sunel overrides.
  sunElevationDeg: 5,
}

function resolveParam(search, key, fallback, isValid) {
  const raw = parseFloat(new URLSearchParams(search).get(key))
  return Number.isFinite(raw) && isValid(raw) ? raw : fallback
}

export function resolveLensReflectionConfig(search) {
  return {
    intensity: resolveParam(search, 'lensrefl', DEFAULTS.intensity, (v) => v >= 0),
    roughness: resolveParam(search, 'lensrough', DEFAULTS.roughness, (v) => v >= 0 && v <= 1),
    // Unbounded on purpose: azimuth wraps, so any finite value is meaningful.
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
  // config is guarded alongside envMap because GlassesModelLoader defaults
  // lensReflection to null independently of lensEnvMap: they are separately
  // nullable, so a present envMap does not imply a present config.
  if (!material || !envMap || !config) {
    return
  }

  material.envMap = envMap
  material.envMapIntensity = config.intensity

  if ('roughness' in material && material.roughness < config.roughness) {
    material.roughness = config.roughness
  }
}
