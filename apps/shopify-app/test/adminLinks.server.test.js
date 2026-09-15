import { describe, it, expect } from 'vitest'
import { themeEditorUrl, previewUrl } from '../app/adminLinks.server.js'

describe('themeEditorUrl', () => {
  it('targets the product template on the current theme', () => {
    const url = new URL(themeEditorUrl('demo-shop.myshopify.com'))
    expect(url.host).toBe('demo-shop.myshopify.com')
    expect(url.pathname).toBe('/admin/themes/current/editor')
    expect(url.searchParams.get('template')).toBe('product')
    expect(url.searchParams.get('target')).toBe('mainSection')
    expect(url.searchParams.get('addAppBlockId')).toBe(
      'be1db9d64c7c617dcd67f6add58f4824/tryon_button',
    )
  })

  it('previews the selected product when its handle is available', () => {
    const url = new URL(themeEditorUrl('demo-shop.myshopify.com', 'black-wayfarer'))
    expect(url.searchParams.get('previewPath')).toBe('/products/black-wayfarer')
    expect(url.searchParams.has('template')).toBe(false)
  })

})

describe('previewUrl', () => {
  const base = {
    engineUrl: 'https://ar-sunglasses-tryon.vercel.app/tryon/index.html',
    shop: 'demo-shop.myshopify.com',
    productId: 'gid://shopify/Product/123',
  }

  it('carries shop and product', () => {
    const url = new URL(previewUrl(base))
    expect(url.searchParams.get('shop')).toBe('demo-shop.myshopify.com')
    expect(url.searchParams.get('productId')).toBe('gid://shopify/Product/123')
  })

  // Load-bearing: without this marker a merchant previewing their own product
  // would mark it "live" and complete the theme step with no block installed.
  it('always marks itself as preview traffic', () => {
    expect(new URL(previewUrl(base)).searchParams.get('src')).toBe('preview')
  })

})
