import { describe, it, expect, beforeEach, vi } from 'vitest'

const deps = vi.hoisted(() => ({ map: vi.fn(), publish: vi.fn() }))
vi.mock('../app/models.server.js', () => ({ mapProductToModel: (...a) => deps.map(...a) }))
vi.mock('../app/tryonMetafield.server.js', () => ({ publishMapping: (...a) => deps.publish(...a) }))

const { addGeneratedModelToProduct } = await import('../app/aiProductMapping.server.js')

const SHOP = 'gen-test.myshopify.com'
const PRODUCT = 'gid://shopify/Product/42'
function prismaWith({ existing = null, count = 0 } = {}) {
  return { productMapping: { findUnique: vi.fn(async () => existing), count: vi.fn(async () => count) } }
}
const args = (prisma, planName = 'Starter') => ({ prisma, admin: {}, shop: SHOP, planName, productId: PRODUCT, productHandle: 'gripz-pelmo', modelAssetId: 'asset-1' })

beforeEach(() => {
  vi.resetAllMocks()
  deps.map.mockResolvedValue({})
  deps.publish.mockResolvedValue(undefined)
})

describe('addGeneratedModelToProduct', () => {
  it('maps and publishes a new product within the plan limit', async () => {
    const prisma = prismaWith({ count: 3 })
    await expect(addGeneratedModelToProduct(args(prisma))).resolves.toEqual({ mapped: true })
    expect(deps.map).toHaveBeenCalledWith(prisma, SHOP, PRODUCT, 'asset-1', 'gripz-pelmo')
    expect(deps.publish).toHaveBeenCalledWith({}, PRODUCT)
  })

  it('remaps a product that already has try-on even at the limit', async () => {
    const prisma = prismaWith({ existing: { id: 'm1' }, count: 10 })
    await expect(addGeneratedModelToProduct(args(prisma))).resolves.toEqual({ mapped: true })
    expect(prisma.productMapping.count).not.toHaveBeenCalled()
  })

  it('does not map a new product past the plan limit', async () => {
    const prisma = prismaWith({ count: 10 })
    await expect(addGeneratedModelToProduct(args(prisma))).resolves.toEqual({ mapped: false, reason: 'product_limit' })
    expect(deps.map).not.toHaveBeenCalled()
  })

  it('reports (never throws) map and publish failures', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      deps.map.mockRejectedValueOnce(new Error('db'))
      await expect(addGeneratedModelToProduct(args(prismaWith()))).resolves.toEqual({ mapped: false, reason: 'map_failed' })
      deps.publish.mockRejectedValueOnce(new Error('shopify'))
      await expect(addGeneratedModelToProduct(args(prismaWith()))).resolves.toEqual({ mapped: false, reason: 'publish_failed' })
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
