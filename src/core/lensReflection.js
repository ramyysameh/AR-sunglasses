// Lens reflection tuning. Defaults are baked from on-device tuning; the URL
// params exist to re-tune on a real phone, exactly like ?gscale and ?voffset.
const DEFAULTS = {
  // Lowered from 1.8 (tuned for the old 0.62-opacity, medium-grey lens) after
  // the lens went darker + more transparent (opacity 0.35, near-black tint):
  // at that contrast, a bright sun glint sweeping across the dark tint as the
  // head turns read as an inconsistent grey/black flicker rather than a
  // subtle highlight. Confirmed live on a real registered model.
  intensity: 0.5,
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
  // A thin glossy clearcoat, not the base material reflection: real glass gets
  // MUCH more reflective at grazing angles than face-on (Fresnel), which envMap +
  // envMapIntensity alone doesn't reproduce (that's a flat multiplier regardless
  // of view angle). Three's clearcoat lobe is view-angle-weighted by construction,
  // so it reads as a rim highlight around the lens edge instead of a uniform sheen.
  clearcoat: 1,
  // Smooth enough for a crisp rim glint, not a hard mirror edge.
  clearcoatRoughness: 0.12,
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
    clearcoat: resolveParam(search, 'lensclearcoat', DEFAULTS.clearcoat, (v) => v >= 0 && v <= 1),
    clearcoatRoughness: resolveParam(search, 'lensclearcoatrough', DEFAULTS.clearcoatRoughness, (v) => v >= 0 && v <= 1),
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

  // Clearcoat is a separate BRDF lobe in Three's physical material, weighted by
  // its own Fresnel term -- unlike envMapIntensity (a flat multiplier applied
  // equally everywhere), it's naturally strong at grazing angles and weak
  // face-on, which is what actually reads as "real glass" rather than a flat
  // sheen painted over the whole lens.
  if ('clearcoat' in material) {
    material.clearcoat = config.clearcoat
    material.clearcoatRoughness = config.clearcoatRoughness
  }
}
