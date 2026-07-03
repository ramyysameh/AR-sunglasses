/**
 * Per-model transform presets for glasses assets.
 */
import * as THREE from 'three'

export const glassesConfig = {
  sunglasses: {
    modelPath: 'models/sunglasses.glb',
    optimizedModelPath: 'models/sunglasses-opt.glb',
    normalizedModelPath: 'models/normalized/sunglasses.glb',
    runtimeModelPath: 'models/sunglasses-draco.glb',
    name: 'sunglasses',
    displayName: 'Sunglasses',
    modelUnit: 'meters',
    frameWidthMeters: 0.136,
    frameWidthMm: 145,
    lensWidthMm: 54,
    bridgeWidthMm: 18,
    lensHeightMm: 43,
    templeLengthMm: 145,
    lensHeightMeters: 0.043,
    bridgeWidthMeters: 0.018,
    templeLengthMeters: 0.145,
    bridgeClearanceMeters: 0.012,
    frontFrameDepthMeters: 0,
    nosePadOffsetMeters: 0.004,
    templeBackOffsetMeters: 0.12,
    canonicalOffset: new THREE.Vector3(0, -0.012, 0),
    bridgeLocalOffset: new THREE.Vector3(0, -0.012, 0),
    bridgePivot: new THREE.Vector3(0, 0, -0.02),
    frontFramePlane: new THREE.Vector3(0, 0, 0),
    leftHingePoint: new THREE.Vector3(-0.0725, 0, 0),
    rightHingePoint: new THREE.Vector3(0.0725, 0, 0),
    frontFrameClearanceMeters: 0.003,
    lensCenterOffset: new THREE.Vector3(0, 0.004, 0),
    depthPivot: 'frontMaxZ',
    scaleMultiplier: 1.0,
    faceFitWidthRatio: 0.88,
    scaleLimits: { min: 0.85, max: 1.15 },
    fitDamping: 0.2,
    rotationOffset: new THREE.Euler(0, 0, 0),
    materialProfile: {
      frameRoughness: 0.34,
      frameMetalness: 0.08,
      lensRoughness: 0.08,
      lensOpacity: 0.62,
    },
    templeFade: { start: -0.08, end: -0.12 },
    useOptimizedModel: false,
    useNormalizedModel: true,
  },
  gripz1: {
    modelPath: 'models/gripz1.glb',
    optimizedModelPath: 'models/gripz1-opt.glb',
    normalizedModelPath: 'models/normalized/gripz1.glb',
    runtimeModelPath: 'models/gripz1-draco.glb',
    name: 'gripz1',
    displayName: 'Gripz 1',
    modelUnit: 'meters',
    frameWidthMeters: 0.136,
    frameWidthMm: 145,
    lensWidthMm: 54,
    bridgeWidthMm: 18,
    lensHeightMm: 43,
    templeLengthMm: 145,
    lensHeightMeters: 0.043,
    bridgeWidthMeters: 0.018,
    templeLengthMeters: 0.145,
    bridgeClearanceMeters: 0.012,
    frontFrameDepthMeters: 0,
    nosePadOffsetMeters: 0.004,
    templeBackOffsetMeters: 0.12,
    canonicalOffset: new THREE.Vector3(0, -0.012, 0),
    bridgeLocalOffset: new THREE.Vector3(0, -0.012, 0),
    bridgePivot: new THREE.Vector3(0, 0, -0.02),
    frontFramePlane: new THREE.Vector3(0, 0, 0),
    leftHingePoint: new THREE.Vector3(-0.0725, 0, 0),
    rightHingePoint: new THREE.Vector3(0.0725, 0, 0),
    frontFrameClearanceMeters: 0.003,
    lensCenterOffset: new THREE.Vector3(0, 0.004, 0),
    depthPivot: 'frontMaxZ',
    scaleMultiplier: 1.0,
    faceFitWidthRatio: 0.88,
    scaleLimits: { min: 0.85, max: 1.15 },
    fitDamping: 0.2,
    rotationOffset: new THREE.Euler(0, 0, 0),
    materialProfile: {
      frameRoughness: 0.34,
      frameMetalness: 0.08,
      lensRoughness: 0.08,
      lensOpacity: 0.62,
    },
    templeFade: { start: -0.08, end: -0.12 },
    useOptimizedModel: false,
    useNormalizedModel: true,
  },
  gripzpelmo: {
    modelPath: 'models/gripzpelmo.glb',
    normalizedModelPath: 'models/normalized/gripzpelmo.glb',
    runtimeModelPath: 'models/gripzpelmo-draco.glb',
    name: 'gripzpelmo',
    displayName: 'Gripz Pelmo',
    modelUnit: 'meters',
    // Raw (un-normalized) model width in GLB units — used by the fit solver to
    // scale the glasses down onto the face.
    frameWidthMeters: 3.312,
    frameWidthMm: 145,
    lensWidthMm: 54,
    bridgeWidthMm: 18,
    lensHeightMm: 43,
    templeLengthMm: 145,
    lensHeightMeters: 0.043,
    bridgeWidthMeters: 0.018,
    templeLengthMeters: 0.145,
    bridgeClearanceMeters: 0.012,
    frontFrameDepthMeters: 0,
    nosePadOffsetMeters: 0.004,
    templeBackOffsetMeters: 0.12,
    canonicalOffset: new THREE.Vector3(0, -0.012, 0),
    bridgeLocalOffset: new THREE.Vector3(0, -0.012, 0),
    bridgePivot: new THREE.Vector3(0, 0, -0.02),
    frontFramePlane: new THREE.Vector3(0, 0, 0),
    leftHingePoint: new THREE.Vector3(-0.0725, 0, 0),
    rightHingePoint: new THREE.Vector3(0.0725, 0, 0),
    frontFrameClearanceMeters: 0.003,
    lensCenterOffset: new THREE.Vector3(0, 0.004, 0),
    depthPivot: 'frontMaxZ',
    scaleMultiplier: 1.0,
    faceFitWidthRatio: 0.88,
    // Raw model is ~3.3 units wide (full Blender scene scale, not normalized),
    // so the fit scale comes out very small — widen the clamp to allow it.
    scaleLimits: { min: 0.001, max: 0.5 },
    // Low damping = the size changes very slowly, so it stays put during head
    // turns (the face isn't actually getting bigger/smaller).
    fitDamping: 0.08,
    rotationOffset: new THREE.Euler(0, 0, 0),
    materialProfile: {
      frameRoughness: 0.34,
      frameMetalness: 0.08,
      lensRoughness: 0.08,
      // Lens alpha (see-through). Lower = clearer/more eye visible, higher = more tinted.
      lensOpacity: 0.55,
    },
    templeFade: { start: -10, end: -11 },
    useOptimizedModel: false,
    // Load the RAW exported GLB exactly as built — no normalization, no Draco.
    useNormalizedModel: false,
    // Keep the GLB's authored materials/gloss/lens exactly as exported.
    preserveMaterials: true,
  },
  gripz2: {
    modelPath: 'models/gripz2.glb',
    runtimeModelPath: 'models/gripz2-draco.glb',
    name: 'gripz2',
    displayName: 'Gripz 2',
    modelUnit: 'meters',
    frameWidthMeters: 0.136,
    frameWidthMm: 145,
    lensWidthMm: 54,
    bridgeWidthMm: 18,
    lensHeightMm: 43,
    templeLengthMm: 145,
    lensHeightMeters: 0.043,
    bridgeWidthMeters: 0.018,
    templeLengthMeters: 0.145,
    bridgeClearanceMeters: 0.012,
    frontFrameDepthMeters: 0,
    nosePadOffsetMeters: 0.004,
    templeBackOffsetMeters: 0.12,
    canonicalOffset: new THREE.Vector3(0, -0.012, 0),
    bridgeLocalOffset: new THREE.Vector3(0, -0.012, 0),
    bridgePivot: new THREE.Vector3(0, 0, -0.02),
    frontFramePlane: new THREE.Vector3(0, 0, 0),
    leftHingePoint: new THREE.Vector3(-0.0725, 0, 0),
    rightHingePoint: new THREE.Vector3(0.0725, 0, 0),
    frontFrameClearanceMeters: 0.003,
    lensCenterOffset: new THREE.Vector3(0, 0.004, 0),
    depthPivot: 'frontMaxZ',
    scaleMultiplier: 1.0,
    faceFitWidthRatio: 0.88,
    scaleLimits: { min: 0.85, max: 1.15 },
    fitDamping: 0.2,
    rotationOffset: new THREE.Euler(0, 0, 0),
    materialProfile: {
      frameRoughness: 0.34,
      frameMetalness: 0.08,
      lensRoughness: 0.08,
      lensOpacity: 0.62,
    },
    // Temple fade disabled for the first look (range beyond the model's local Z so
    // nothing is hidden). We'll tune it for gripz2's coordinate space after seeing
    // how it sits and whether the temples clip.
    templeFade: { start: -10, end: -11 },
    useOptimizedModel: false,
    useNormalizedModel: true,
  },
}

export const defaultGlassesKey = 'sunglasses'

export function getGlassesConfig(key = defaultGlassesKey) {
  return glassesConfig[key] ?? glassesConfig[defaultGlassesKey]
}

/**
 * Registers a runtime-fetched model config (e.g. from the Shopify app's
 * /api/tryon-config, adapted via fitMetadataAdapter) under a dynamic key so
 * the existing SKU-keyed loading path (getGlassesConfig/getGlassesModelUrl)
 * can serve it without any change to the engine's model-loading code.
 *
 * Missing engine-only fields (materialProfile, templeFade, useNormalizedModel,
 * etc.) are backfilled from the default SKU so the loader always sees a
 * complete config.
 *
 * @param {string} key
 * @param {{ modelUrl: string } & Record<string, unknown>} engineModelConfig
 * @returns {string} the key to pass to loadSku/getGlassesConfig
 */
export function registerRuntimeGlassesConfig(key, engineModelConfig) {
  const base = glassesConfig[defaultGlassesKey]
  const { modelUrl, ...rest } = engineModelConfig

  glassesConfig[key] = {
    ...base,
    ...rest,
    name: key,
    displayName: rest.displayName ?? base.displayName,
    modelPath: modelUrl,
    normalizedModelPath: modelUrl,
    runtimeModelPath: modelUrl,
    optimizedModelPath: modelUrl,
    useNormalizedModel: false,
    useOptimizedModel: false,
  }

  return key
}

// Dev cache-buster: changes once per page load so a freshly re-exported GLB is
// always fetched instead of a stale cached copy.
const MODEL_CACHE_BUST = Date.now()

export function getGlassesModelUrl(key = defaultGlassesKey) {
  const config = getGlassesConfig(key)
  let url
  if (config.useNormalizedModel) {
    // Prefer the Draco-compressed runtime build; fall back to the full-precision
    // normalized asset (e.g. before `npm run compress:models` has been run).
    url = config.runtimeModelPath ?? config.normalizedModelPath ?? config.modelPath
  } else {
    url = config.useOptimizedModel && config.optimizedModelPath
      ? config.optimizedModelPath
      : config.modelPath
  }
  return `${url}?v=${MODEL_CACHE_BUST}`
}

export const defaultGlassesModelUrl = getGlassesModelUrl(defaultGlassesKey)
