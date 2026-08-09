// test/products.server.test.js
import { describe, it, expect, vi } from 'vitest'
import { fetchProductsByIds } from '../app/products.server.js'

function adminReturning(nodes) {
  return {
    graphql: vi.fn(async () => new Response(JSON.stringify({ data: { nodes } }))),
  }
}

describe('fetchProductsByIds', () => {
  it('returns empty Map and does not call graphql for empty ids', async () => {
    const admin = adminReturning([])
    const out = await fetchProductsByIds(admin, [])
    expect(out.size).toBe(0)
    expect(admin.graphql).not.toHaveBeenCalled()
  })

  it('maps id -> title + image and omits deleted products', async () => {
    const admin = adminReturning([
      { id: 'gid://shopify/Product/1', title: 'Aviator', featuredImage: { url: 'https://cdn/x.jpg', altText: 'Aviator' } },
      null, // deleted product
    ])
    const out = await fetchProductsByIds(admin, ['gid://shopify/Product/1', 'gid://shopify/Product/2'])
    expect(out.get('gid://shopify/Product/1')).toEqual({
      id: 'gid://shopify/Product/1',
      title: 'Aviator',
      imageUrl: 'https://cdn/x.jpg',
      imageAlt: 'Aviator',
    })
    expect(out.has('gid://shopify/Product/2')).toBe(false)
  })

  it('deduplicates ids before querying', async () => {
    const admin = adminReturning([
      { id: 'gid://shopify/Product/1', title: 'A', featuredImage: null },
    ])
    await fetchProductsByIds(admin, ['gid://shopify/Product/1', 'gid://shopify/Product/1'])
    const passedVars = admin.graphql.mock.calls[0][1].variables
    expect(passedVars.ids).toEqual(['gid://shopify/Product/1'])
  })
})
