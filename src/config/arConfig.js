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
}

export const defaultGlassesKey = 'sunglasses'

export function getGlassesConfig(key = defaultGlassesKey) {
  return glassesConfig[key] ?? glassesConfig[defaultGlassesKey]
}

export function getGlassesModelUrl(key = defaultGlassesKey) {
  const config = getGlassesConfig(key)
  if (config.useNormalizedModel) {
    // Prefer the Draco-compressed runtime build; fall back to the full-precision
    // normalized asset (e.g. before `npm run compress:models` has been run).
    return config.runtimeModelPath ?? config.normalizedModelPath ?? config.modelPath
  }

  return config.useOptimizedModel && config.optimizedModelPath
    ? config.optimizedModelPath
    : config.modelPath
}

export const defaultGlassesModelUrl = getGlassesModelUrl(defaultGlassesKey)
