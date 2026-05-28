import { defaultGlassesKey } from './arConfig.js'

const globalConfig = typeof window !== 'undefined'
  ? window.AR_TRYON_CONFIG ?? {}
  : {}
const env = typeof import.meta !== 'undefined'
  ? import.meta.env ?? {}
  : {}

function value(name, fallback = '') {
  return globalConfig[name] ?? env[name] ?? fallback
}

function numberValue(name, fallback) {
  const rawValue = value(name, '')
  const parsed = Number(rawValue)

  return Number.isFinite(parsed) ? parsed : fallback
}

function boolValue(name, fallback) {
  const rawValue = value(name, '')
  if (rawValue === '') return fallback

  return !['0', 'false', 'no'].includes(String(rawValue).toLowerCase())
}

function definedValues(object = {}) {
  return Object.fromEntries(
    Object.entries(object).filter(([, fieldValue]) => fieldValue !== undefined)
  )
}

export const tryOnSkuConfigs = {
  sunglasses: {
    shopifyProductId: value('VITE_SHOPIFY_PRODUCT_ID_SUNGLASSES', 'demo-product-sunglasses'),
    shopifyVariantId: value('VITE_SHOPIFY_VARIANT_ID_SUNGLASSES', 'demo-variant-sunglasses'),
    sku: 'sunglasses',
    lensId: value('VITE_SNAP_LENS_ID_SUNGLASSES', value('VITE_SNAP_LENS_ID', '')),
    lensGroupId: value('VITE_SNAP_LENS_GROUP_ID_SUNGLASSES', value('VITE_SNAP_LENS_GROUP_ID', '')),
    modelAssetId: 'models/normalized/sunglasses.glb',
    frameWidthMm: 145,
    lensWidthMm: 54,
    bridgeWidthMm: 18,
    templeLengthMm: 145,
    lensHeightMm: 43,
    bridgeCenter: { x: 0, y: 0, z: 0 },
    frameFrontPlane: { x: 0, y: 0, z: 0 },
    leftHingePoint: { x: -72.5, y: 0, z: 0 },
    rightHingePoint: { x: 72.5, y: 0, z: 0 },
    fitProfileVersion: 'eyewear-v1',
  },
  gripz1: {
    shopifyProductId: value('VITE_SHOPIFY_PRODUCT_ID_GRIPZ1', 'demo-product-gripz1'),
    shopifyVariantId: value('VITE_SHOPIFY_VARIANT_ID_GRIPZ1', 'demo-variant-gripz1'),
    sku: 'gripz1',
    lensId: value('VITE_SNAP_LENS_ID_GRIPZ1', value('VITE_SNAP_LENS_ID', '')),
    lensGroupId: value('VITE_SNAP_LENS_GROUP_ID_GRIPZ1', value('VITE_SNAP_LENS_GROUP_ID', '')),
    modelAssetId: 'models/normalized/gripz1.glb',
    frameWidthMm: 145,
    lensWidthMm: 54,
    bridgeWidthMm: 18,
    templeLengthMm: 145,
    lensHeightMm: 43,
    bridgeCenter: { x: 0, y: 0, z: 0 },
    frameFrontPlane: { x: 0, y: 0, z: 0 },
    leftHingePoint: { x: -72.5, y: 0, z: 0 },
    rightHingePoint: { x: 72.5, y: 0, z: 0 },
    fitProfileVersion: 'eyewear-v1',
  },
}

export const tryOnRuntimeConfig = {
  defaultProvider: value('VITE_TRYON_PROVIDER', 'mediapipe'),
  fallbackProvider: value('VITE_TRYON_FALLBACK_PROVIDER', 'mediapipe'),
  allowLocalFallback: boolValue('VITE_TRYON_ALLOW_LOCAL_FALLBACK', true),
  defaultSkuKey: value('VITE_TRYON_DEFAULT_SKU', defaultGlassesKey),
  skus: tryOnSkuConfigs,
  snap: {
    apiToken: value('VITE_SNAP_CAMERA_KIT_API_TOKEN', ''),
    logger: value('VITE_SNAP_CAMERA_KIT_LOGGER', 'noop'),
    fpsLimit: numberValue('VITE_SNAP_CAMERA_KIT_FPS_LIMIT', 60),
  },
  camera: {
    width: numberValue('VITE_TRYON_CAMERA_WIDTH', 1280),
    height: numberValue('VITE_TRYON_CAMERA_HEIGHT', 720),
  },
}

export function getTryOnRuntimeConfig(overrides = {}) {
  const safeOverrides = definedValues(overrides)

  return {
    ...tryOnRuntimeConfig,
    ...globalConfig,
    ...safeOverrides,
    snap: {
      ...tryOnRuntimeConfig.snap,
      ...(globalConfig.snap ?? {}),
      ...(safeOverrides.snap ?? {}),
    },
    camera: {
      ...tryOnRuntimeConfig.camera,
      ...(globalConfig.camera ?? {}),
      ...(safeOverrides.camera ?? {}),
    },
    skus: {
      ...tryOnSkuConfigs,
      ...(globalConfig.skus ?? {}),
      ...(safeOverrides.skus ?? {}),
    },
  }
}
