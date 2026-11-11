import { describe, it, expect, vi } from 'vitest'

const deleted = vi.hoisted(() => [])
vi.mock('../app/storage.server.js', () => ({
  deleteModelGlb: async (key) => {
    deleted.push(key)
  },
}))

const { purgeShopData } = await import('../app/webhooks.server.js')

const SHOP = 'purge-ai.myshopify.com'

// DB-free stand-in: just enough of each delegate for purgeShopData.
function table(rows) {
  return {
    findMany: async ({ where }) => rows.filter((r) => r.shop === where.shop),
    deleteMany: async ({ where }) => {
      const before = rows.length
      rows.splice(0, rows.length, ...rows.filter((r) => r.shop !== where.shop))
      return { count: before - rows.length }
    },
  }
}

describe('purgeShopData and AI generations', () => {
  it('deletes generation photos and pending GLBs before any rows, then the rows', async () => {
    const generationRows = [
      { shop: SHOP, photoRefs: [`generation-photos/${SHOP}/1a.jpg`, `generation-photos/${SHOP}/2b.jpg`], glbRef: 'generations/g.glb' },
      { shop: SHOP, photoRefs: [], glbRef: null },
      { shop: 'other.myshopify.com', photoRefs: ['generation-photos/other.myshopify.com/3c.jpg'], glbRef: null },
    ]
    const photoRows = [
      { shop: SHOP, clientKey: 'k1' },
      { shop: 'other.myshopify.com', clientKey: 'k2' },
    ]
    const offRows = [{ shop: SHOP, productId: 'gid://shopify/Product/1' }, { shop: 'other.myshopify.com', productId: 'gid://shopify/Product/2' }]
    const prisma = {
      modelAsset: table([{ shop: SHOP, storageRef: 'a.glb' }]),
      productMapping: table([]),
      session: table([]),
      shopSubscription: table([]),
      modelGeneration: table(generationRows),
      photoTryon: table(photoRows),
      photoTryonOff: table(offRows),
    }

    const result = await purgeShopData(prisma, SHOP)

    expect(deleted).toEqual(['a.glb', `generation-photos/${SHOP}/1a.jpg`, `generation-photos/${SHOP}/2b.jpg`, 'generations/g.glb'])
    expect(result.generations).toBe(2)
    expect(generationRows).toHaveLength(1)
    expect(generationRows[0].shop).toBe('other.myshopify.com')
    // Photo try-on counters (salted IP hashes) go too; other shops' stay.
    expect(result.photoTryons).toBe(1)
    expect(photoRows.map((r) => r.shop)).toEqual(['other.myshopify.com'])
    expect(offRows.map((r) => r.shop)).toEqual(['other.myshopify.com'])
  })
})
