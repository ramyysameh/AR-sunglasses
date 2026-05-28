/**
 * Per-model transform presets for glasses assets.
 */
import * as THREE from 'three'

export const glassesConfig = {
  sunglasses: {
    modelPath: 'models/sunglasses.glb',
    optimizedModelPath: 'models/sunglasses-opt.glb',
    normalizedModelPath: 'models/normalized/sunglasses.glb',
    name: 'sunglasses',
    modelUnit: 'meters',
    frameWidthMeters: 0.145,
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
    canonicalOffset: new THREE.Vector3(0, -0.004, 0),
    bridgeLocalOffset: new THREE.Vector3(0, -0.004, 0),
    bridgePivot: new THREE.Vector3(0, 0, 0),
    frontFramePlane: new THREE.Vector3(0, 0, 0),
    leftHingePoint: new THREE.Vector3(-0.0725, 0, 0),
    rightHingePoint: new THREE.Vector3(0.0725, 0, 0),
    frontFrameClearanceMeters: 0.006,
    lensCenterOffset: new THREE.Vector3(0, 0.004, 0),
    depthPivot: 'frontMaxZ',
    scaleMultiplier: 1.0,
    faceFitWidthRatio: 0.55,
    scaleLimits: { min: 1.05, max: 1.85 },
    fitDamping: 0.2,
    rotationOffset: new THREE.Euler(0, 0, 0),
    materialProfile: {
      frameRoughness: 0.34,
      frameMetalness: 0.08,
      lensRoughness: 0.08,
      lensOpacity: 0.62,
    },
    useOptimizedModel: false,
    useNormalizedModel: true,
  },
  gripz1: {
    modelPath: 'models/gripz1.glb',
    optimizedModelPath: 'models/gripz1-opt.glb',
    normalizedModelPath: 'models/normalized/gripz1.glb',
    name: 'gripz1',
    modelUnit: 'meters',
    frameWidthMeters: 0.145,
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
    canonicalOffset: new THREE.Vector3(0, -0.004, 0),
    bridgeLocalOffset: new THREE.Vector3(0, -0.004, 0),
    bridgePivot: new THREE.Vector3(0, 0, 0),
    frontFramePlane: new THREE.Vector3(0, 0, 0),
    leftHingePoint: new THREE.Vector3(-0.0725, 0, 0),
    rightHingePoint: new THREE.Vector3(0.0725, 0, 0),
    frontFrameClearanceMeters: 0.006,
    lensCenterOffset: new THREE.Vector3(0, 0.004, 0),
    depthPivot: 'frontMaxZ',
    scaleMultiplier: 1.0,
    faceFitWidthRatio: 0.55,
    scaleLimits: { min: 1.05, max: 1.85 },
    fitDamping: 0.2,
    rotationOffset: new THREE.Euler(0, 0, 0),
    materialProfile: {
      frameRoughness: 0.34,
      frameMetalness: 0.08,
      lensRoughness: 0.08,
      lensOpacity: 0.62,
    },
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
  if (config.useNormalizedModel && config.normalizedModelPath) {
    return config.normalizedModelPath
  }

  return config.useOptimizedModel && config.optimizedModelPath
    ? config.optimizedModelPath
    : config.modelPath
}

export const defaultGlassesModelUrl = getGlassesModelUrl(defaultGlassesKey)
