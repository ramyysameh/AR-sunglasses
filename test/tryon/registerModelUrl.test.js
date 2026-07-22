import { describe, it, expect } from 'vitest'
import { buildRegisterModelUrl } from '../../src/tryon/registerModelUrl.js'

describe('buildRegisterModelUrl', () => {
  it('includes both the model url and the shop, encoded', () => {
    const url = buildRegisterModelUrl(
      'https://cdn.shopify.com/s/files/1/0868/a b.glb',
      'demo-shop.myshopify.com',
    )
    expect(url).toBe(
      '/api/register-model?url=https%3A%2F%2Fcdn.shopify.com%2Fs%2Ffiles%2F1%2F0868%2Fa%20b.glb&shop=demo-shop.myshopify.com',
    )
  })

  it('throws without a shop, since the app rejects an unattributed registration', () => {
    // Failing loudly here beats a 400 the engine would silently swallow into a
    // fallback, hiding the real cause.
    expect(() => buildRegisterModelUrl('https://cdn.shopify.com/a.glb', undefined)).toThrow()
  })
})
