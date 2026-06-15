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
  defaultSkuKey: value('VITE_TRYON_DEFAULT_SKU', defaultGlassesKey),
  skus: tryOnSkuConfigs,
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
