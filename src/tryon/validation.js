const REQUIRED_STRING_FIELDS = [
  'shopifyProductId',
  'shopifyVariantId',
  'sku',
  'modelAssetId',
  'fitProfileVersion',
]

const REQUIRED_POSITIVE_NUMBER_FIELDS = [
  'frameWidthMm',
  'lensWidthMm',
  'bridgeWidthMm',
  'templeLengthMm',
  'lensHeightMm',
]

const REQUIRED_VECTOR_FIELDS = [
  'bridgeCenter',
  'frameFrontPlane',
  'leftHingePoint',
  'rightHingePoint',
]

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isPositiveNumber(value) {
  return Number.isFinite(value) && value > 0
}

function isVector3Like(value) {
  return value &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
}

export function validateTryOnSkuConfig(skuConfig) {
  const errors = []

  for (const field of REQUIRED_STRING_FIELDS) {
    if (!isNonEmptyString(skuConfig?.[field])) {
      errors.push(`${skuConfig?.sku ?? 'unknown'} is missing ${field}`)
    }
  }

  for (const field of REQUIRED_POSITIVE_NUMBER_FIELDS) {
    if (!isPositiveNumber(skuConfig?.[field])) {
      errors.push(`${skuConfig?.sku ?? 'unknown'} has invalid ${field}`)
    }
  }

  for (const field of REQUIRED_VECTOR_FIELDS) {
    if (!isVector3Like(skuConfig?.[field])) {
      errors.push(`${skuConfig?.sku ?? 'unknown'} has invalid ${field}`)
    }
  }

  return errors
}

export function validateTryOnSkuCatalog(skus = {}) {
  const errors = []
  const productVariantKeys = new Set()

  for (const [key, skuConfig] of Object.entries(skus)) {
    errors.push(...validateTryOnSkuConfig(skuConfig))

    if (skuConfig?.sku !== key) {
      errors.push(`${key} has mismatched sku value ${skuConfig?.sku}`)
    }

    const mappingKey = `${skuConfig?.shopifyProductId}:${skuConfig?.shopifyVariantId}`
    if (productVariantKeys.has(mappingKey)) {
      errors.push(`${key} duplicates Shopify variant mapping ${mappingKey}`)
    }
    productVariantKeys.add(mappingKey)
  }

  return errors
}
