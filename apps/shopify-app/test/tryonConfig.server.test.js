import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import prisma from '../app/db.server.js'
import { getTryonConfig } from '../app/tryonConfig.server.js'

const shop = 'cfg-test.myshopify.com'
const productId = 'gid://shopify/Product/42'
let assetId

beforeAll(async () => {
  const a = await prisma.modelAsset.create({ data: { shop, storageRef: 'r', fitMetadata: { version: 'eyewear-v1' }, confidence: null } })
  assetId = a.id
  await prisma.productMapping.create({ data: { shop, productId, modelAssetId: assetId } })
})
afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
})

describe('getTryonConfig', () => {
  it('returns modelUrl + fitMetadata for a mapped product', async () => {
    const cfg = await getTryonConfig(prisma, shop, productId)
    expect(cfg.modelUrl).toBe(`/models/${assetId}.glb`)
    expect(cfg.fitMetadata.version).toBe('eyewear-v1')
  })
  it('returns null for an unmapped product', async () => {
    expect(await getTryonConfig(prisma, shop, 'gid://shopify/Product/999')).toBeNull()
  })
})
