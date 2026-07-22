import { describe, it, expect, afterAll } from 'vitest'
import prisma from '../app/db.server.js'
import { mapProductToModel, listMappings } from '../app/models.server.js'

const shop = 'map-test.myshopify.com'
const productId = 'gid://shopify/Product/123'

const otherShop = `map-test-other-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`

afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  await prisma.productMapping.deleteMany({ where: { shop: otherShop } })
  await prisma.modelAsset.deleteMany({ where: { shop: otherShop } })
})

describe('mapProductToModel + listMappings', () => {
  it('upserts a product->model mapping (no duplicate on re-map) and lists it', async () => {
    const asset = await prisma.modelAsset.create({
      data: { shop, storageRef: 'r1', fitMetadata: { version: 'eyewear-v1' }, confidence: null },
    })

    await mapProductToModel(prisma, shop, productId, asset.id)
    let maps = await listMappings(prisma, shop)
    expect(maps).toHaveLength(1)
    expect(maps[0].productId).toBe(productId)
    expect(maps[0].modelAssetId).toBe(asset.id)
    expect(maps[0].modelAsset.id).toBe(asset.id)

    // Re-map the same product to a different model -> upsert, still one row.
    const asset2 = await prisma.modelAsset.create({
      data: { shop, storageRef: 'r2', fitMetadata: { version: 'eyewear-v1' }, confidence: null },
    })
    await mapProductToModel(prisma, shop, productId, asset2.id)
    maps = await listMappings(prisma, shop)
    expect(maps).toHaveLength(1)
    expect(maps[0].modelAssetId).toBe(asset2.id)
  })

  it('rejects mapping a product to another shop\'s asset (cross-tenant guard)', async () => {
    const foreignAsset = await prisma.modelAsset.create({
      data: { shop: otherShop, storageRef: 'foreign-r1', fitMetadata: { version: 'eyewear-v1' }, confidence: null },
    })

    await expect(
      mapProductToModel(prisma, shop, productId, foreignAsset.id),
    ).rejects.toThrow('model asset does not belong to this shop')

    const maps = await prisma.productMapping.findMany({ where: { shop, modelAssetId: foreignAsset.id } })
    expect(maps).toHaveLength(0)
  })
})
