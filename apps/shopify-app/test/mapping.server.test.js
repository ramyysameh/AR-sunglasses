import { describe, it, expect, afterAll } from 'vitest'
import prisma from '../app/db.server.js'
import { mapProductToModel, listMappings } from '../app/models.server.js'

const shop = 'map-test.myshopify.com'
const productId = 'gid://shopify/Product/123'

afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
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
})
