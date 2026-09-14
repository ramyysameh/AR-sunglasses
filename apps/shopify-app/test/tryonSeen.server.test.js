import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { recordTryonSeen, SEEN_THROTTLE_MS } from '../app/tryonConfig.server.js'

const tag = randomUUID().slice(0, 8)
const shop = `seen-${tag}.myshopify.com`
const productId = `gid://shopify/Product/${tag}`

const prisma = (await import('../app/db.server.js')).default

let assetId
beforeEach(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  const asset = await prisma.modelAsset.create({ data: { shop, storageRef: `${tag}/m.glb`, fitMetadata: {} } })
  assetId = asset.id
  await prisma.productMapping.create({ data: { shop, productId, modelAssetId: assetId } })
})
afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
})

const read = () =>
  prisma.productMapping.findUnique({ where: { shop_productId: { shop, productId } } })

describe('recordTryonSeen', () => {
  it('stamps a mapping that has never been seen', async () => {
    const now = new Date('2026-09-14T12:00:00Z')
    expect(await recordTryonSeen(prisma, shop, productId, now)).toBe(true)
    expect((await read()).lastSeenLiveAt.toISOString()).toBe(now.toISOString())
  })

  // This endpoint is effectively edge-cacheable and must not take a write per
  // try-on open.
  it('does not write again inside the throttle window', async () => {
    const first = new Date('2026-09-14T12:00:00Z')
    await recordTryonSeen(prisma, shop, productId, first)
    const soon = new Date(first.getTime() + SEEN_THROTTLE_MS - 1000)
    expect(await recordTryonSeen(prisma, shop, productId, soon)).toBe(false)
    expect((await read()).lastSeenLiveAt.toISOString()).toBe(first.toISOString())
  })

  it('writes again once the window has passed', async () => {
    const first = new Date('2026-09-14T12:00:00Z')
    await recordTryonSeen(prisma, shop, productId, first)
    const later = new Date(first.getTime() + SEEN_THROTTLE_MS + 1000)
    expect(await recordTryonSeen(prisma, shop, productId, later)).toBe(true)
    expect((await read()).lastSeenLiveAt.toISOString()).toBe(later.toISOString())
  })

  it('is a no-op for an unmapped product', async () => {
    expect(await recordTryonSeen(prisma, shop, 'gid://shopify/Product/absent')).toBe(false)
  })
})
