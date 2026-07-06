import { describe, it, expect } from 'vitest'
import prisma from '../app/db.server.js'

describe('ModelAsset + ProductMapping', () => {
  it('persists a model asset and maps a product to it', async () => {
    const asset = await prisma.modelAsset.create({
      data: { shop: 'test.myshopify.com', storageRef: 'ref1', fitMetadata: { version: 'eyewear-v1' }, confidence: null },
    })
    const mapping = await prisma.productMapping.create({
      data: { shop: 'test.myshopify.com', productId: 'gid://shopify/Product/1', modelAssetId: asset.id },
    })
    const found = await prisma.productMapping.findUnique({
      where: { shop_productId: { shop: 'test.myshopify.com', productId: 'gid://shopify/Product/1' } },
      include: { modelAsset: true },
    })
    expect(found.modelAsset.id).toBe(asset.id)
    await prisma.productMapping.delete({ where: { id: mapping.id } })
    await prisma.modelAsset.delete({ where: { id: asset.id } })
  })
})
