import assert from 'node:assert/strict'
import {
  tryOnRuntimeConfig,
  tryOnSkuConfigs,
} from '../src/config/tryOnConfig.js'
import {
  validateTryOnSkuCatalog,
} from '../src/tryon/validation.js'

const errors = validateTryOnSkuCatalog(tryOnSkuConfigs)
assert.deepEqual(errors, [], `try-on SKU catalog is invalid:\n${errors.join('\n')}`)

assert.ok(
  tryOnRuntimeConfig.defaultProvider === 'mediapipe',
  'default provider should be the MediaPipe + Three.js engine'
)

assert.ok(
  Object.prototype.hasOwnProperty.call(tryOnSkuConfigs, tryOnRuntimeConfig.defaultSkuKey),
  'default SKU should exist in the SKU catalog'
)

console.log('Try-on provider and SKU config validation passed')
