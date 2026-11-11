import { describe, it, expect, vi } from 'vitest'
import {
  setProductPhotoTryon,
  loadPhotoTryonPanel,
  isProductPhotoOff,
  handlePhotoTryonAction,
  PHOTO_OFF_KEY,
} from '../app/photoTryonControls.server.js'
import { usageLine, coverageLine } from '../app/components/PhotoTryonCard.jsx'

const SHOP = 'qirpee-w4.myshopify.com'
const P1 = 'gid://shopify/Product/1'
const P2 = 'gid://shopify/Product/2'
const NOW = new Date('2026-11-11T12:00:00Z')

function fakeDb({ off = [], requests = [] } = {}) {
  const offRows = off.map((productId) => ({ shop: SHOP, productId }))
  return {
    offRows,
    photoTryonOff: {
      findUnique: async ({ where }) =>
        offRows.find((r) => r.shop === where.shop_productId.shop && r.productId === where.shop_productId.productId) ?? null,
      findMany: async ({ where }) => offRows.filter((r) => r.shop === where.shop),
      upsert: async ({ where }) => {
        const { shop, productId } = where.shop_productId
        if (!offRows.some((r) => r.shop === shop && r.productId === productId)) offRows.push({ shop, productId })
      },
      deleteMany: async ({ where }) => {
        for (let i = offRows.length - 1; i >= 0; i--) {
          if (offRows[i].shop === where.shop && offRows[i].productId === where.productId) offRows.splice(i, 1)
        }
      },
    },
    photoTryon: {
      count: async ({ where }) => requests.filter((r) => r.shop === where.shop && r.createdAt >= where.createdAt.gte).length,
    },
  }
}

function fakeAdmin({ products = [], hasNextPage = false, userErrors = [] } = {}) {
  const calls = []
  return {
    calls,
    graphql: vi.fn(async (query, { variables }) => {
      calls.push({ query, variables })
      if (query.includes('PhotoTryonProducts')) {
        return { json: async () => ({ data: { products: { nodes: products, pageInfo: { hasNextPage } } } }) }
      }
      const field = query.includes('metafieldsSet') ? 'metafieldsSet' : 'metafieldsDelete'
      return { json: async () => ({ data: { [field]: { userErrors } } }) }
    }),
  }
}

describe('setProductPhotoTryon', () => {
  it('switching off writes the storefront metafield, then records the product', async () => {
    const db = fakeDb()
    const admin = fakeAdmin()
    await setProductPhotoTryon({ db, admin, shop: SHOP, productId: P1, on: false })
    expect(admin.calls[0].query).toContain('metafieldsSet')
    expect(admin.calls[0].variables.metafields[0]).toMatchObject({
      ownerId: P1, namespace: '$app:tryon', key: PHOTO_OFF_KEY, type: 'boolean', value: 'true',
    })
    expect(await isProductPhotoOff(db, SHOP, P1)).toBe(true)
  })

  it('switching on deletes the metafield and the record', async () => {
    const db = fakeDb({ off: [P1] })
    const admin = fakeAdmin()
    await setProductPhotoTryon({ db, admin, shop: SHOP, productId: P1, on: true })
    expect(admin.calls[0].query).toContain('metafieldsDelete')
    expect(await isProductPhotoOff(db, SHOP, P1)).toBe(false)
  })

  it('treats an already-missing metafield as switched on', async () => {
    const db = fakeDb({ off: [P1] })
    const admin = fakeAdmin({ userErrors: [{ message: 'Metafield does not exist' }] })
    await setProductPhotoTryon({ db, admin, shop: SHOP, productId: P1, on: true })
    expect(await isProductPhotoOff(db, SHOP, P1)).toBe(false)
  })

  it('changes nothing when Shopify refuses the metafield write', async () => {
    const db = fakeDb()
    const admin = fakeAdmin({ userErrors: [{ message: 'Access denied' }] })
    await expect(setProductPhotoTryon({ db, admin, shop: SHOP, productId: P1, on: false }))
      .rejects.toMatchObject({ code: 'METAFIELD_FAILED' })
    expect(await isProductPhotoOff(db, SHOP, P1)).toBe(false)
  })

  it('refuses shops without the feature and malformed product ids', async () => {
    const admin = fakeAdmin()
    await expect(setProductPhotoTryon({ db: fakeDb(), admin, shop: 'xmcjg8-uh.myshopify.com', productId: P1, on: false }))
      .rejects.toMatchObject({ code: 'NOT_ENABLED' })
    await expect(setProductPhotoTryon({ db: fakeDb(), admin, shop: SHOP, productId: '1', on: false }))
      .rejects.toMatchObject({ code: 'BAD_PRODUCT' })
    expect(admin.calls).toHaveLength(0)
  })
})

describe('loadPhotoTryonPanel', () => {
  const products = [
    { id: P1, title: 'Ghazal', status: 'ACTIVE', featuredMedia: { preview: { image: { url: 'https://cdn.shopify.com/a.jpg', altText: null } } } },
    { id: P2, title: 'Laval', status: 'ACTIVE', featuredMedia: null },
  ]

  it('is null for shops without the feature, without touching the database', async () => {
    const panel = await loadPhotoTryonPanel({ db: {}, admin: fakeAdmin(), shop: 'xmcjg8-uh.myshopify.com' })
    expect(panel).toBe(null)
  })

  it('marks every product on unless switched off, and counts the last 24 hours', async () => {
    const db = fakeDb({
      off: [P2],
      requests: [
        { shop: SHOP, createdAt: new Date('2026-11-11T09:00:00Z') },
        { shop: SHOP, createdAt: new Date('2026-11-10T09:00:00Z') },
      ],
    })
    const panel = await loadPhotoTryonPanel({ db, admin: fakeAdmin({ products, hasNextPage: true }), shop: SHOP, now: NOW })
    expect(panel.usedToday).toBe(1)
    expect(panel.products.map((p) => [p.title, p.on])).toEqual([['Ghazal', true], ['Laval', false]])
    expect(panel.products[0].imageUrl).toBe('https://cdn.shopify.com/a.jpg')
    expect(panel.onCount).toBe(1)
    expect(panel.hasMore).toBe(true)
    expect(coverageLine(panel)).toBe('On for 1 of 2+ products')
    expect(usageLine(panel)).toBe(`1 of ${panel.dailyLimit} photo try-ons used in the last 24 hours`)
  })
})

describe('handlePhotoTryonAction', () => {
  const form = (entries) => {
    const f = new FormData()
    for (const [k, v] of Object.entries(entries)) f.append(k, v)
    return f
  }

  it('returns the new state on success', async () => {
    const res = await handlePhotoTryonAction({ form: form({ productId: P1, on: 'false' }), db: fakeDb(), admin: fakeAdmin(), shop: SHOP })
    expect(res).toEqual({ photoTryon: { productId: P1, on: false } })
  })

  it('returns a merchant-readable error, never the internal message', async () => {
    const res = await handlePhotoTryonAction({
      form: form({ productId: P1, on: 'false' }),
      db: fakeDb(),
      admin: fakeAdmin({ userErrors: [{ message: 'internal: owner type mismatch' }] }),
      shop: SHOP,
    })
    expect(res.photoTryon.error).toBe("Shopify didn't save the change. Try again.")
    expect(JSON.stringify(res)).not.toContain('owner type mismatch')
  })
})
