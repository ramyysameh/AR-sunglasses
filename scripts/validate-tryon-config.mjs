import assert from 'node:assert/strict'
import {
  tryOnRuntimeConfig,
  tryOnSkuConfigs,
} from '../src/config/tryOnConfig.js'
import {
  buildLensLaunchData,
  validateTryOnSkuCatalog,
} from '../src/tryon/validation.js'

const errors = validateTryOnSkuCatalog(tryOnSkuConfigs)
assert.deepEqual(errors, [], `try-on SKU catalog is invalid:\n${errors.join('\n')}`)

for (const sku of Object.values(tryOnSkuConfigs)) {
  const launchData = buildLensLaunchData(sku)
  assert.equal(launchData.launchParams.sku, sku.sku, `${sku.sku} launch data should include sku`)
  assert.equal(
    launchData.launchParams.frameWidthMm,
    sku.frameWidthMm,
    `${sku.sku} launch data should include physical frame width`
  )
}

assert.ok(
  tryOnRuntimeConfig.defaultProvider === 'mediapipe',
  'default provider should be local MediaPipe until Snap credentials are ready'
)

assert.ok(
  Object.prototype.hasOwnProperty.call(tryOnSkuConfigs, tryOnRuntimeConfig.defaultSkuKey),
  'default SKU should exist in the SKU catalog'
)

console.log('Try-on provider and SKU config validation passed')
