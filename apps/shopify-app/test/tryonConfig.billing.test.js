import { describe, it, expect, vi, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `tc-${tag}.myshopify.com`
const productId = `gid://shopify/Product/${tag}`

// Stub getTryonConfig so a servable shop reaches a 200 without needing real
// mapping data; the billing gate is what we are testing.
vi.mock('../app/tryonConfig.server.js', () => ({
  getTryonConfig: async () => ({ modelUrl: '/models/x.glb', fitMetadata: {} }),
}))

const prisma = (await import('../app/db.server.js')).default
const { loader } = await import('../app/routes/api.tryon-config.jsx')

function req() {
  return {
    request: new Request(
      `https://x/api/tryon-config?shop=${encodeURIComponent(shop)}&productId=${encodeURIComponent(productId)}`,
    ),
  }
}

afterAll(async () => {
  await prisma.shopSubscription.deleteMany({ where: { shop } })
})

describe('api.tryon-config billing gate', () => {
  it('402 when the shop has no subscription', async () => {
    const res = await loader(req())
    expect(res.status).toBe(402)
  })

  it('serves (200) for an ACTIVE shop', async () => {
    await prisma.shopSubscription.create({ data: { shop, planName: 'Starter', status: 'ACTIVE' } })
    const res = await loader(req())
    expect(res.status).toBe(200)
  })

  it('402 once the grace window has passed', async () => {
    await prisma.shopSubscription.update({
      where: { shop },
      data: { status: 'CANCELLED', graceEndsAt: new Date(Date.now() - 1000) },
    })
    const res = await loader(req())
    expect(res.status).toBe(402)
  })
})
