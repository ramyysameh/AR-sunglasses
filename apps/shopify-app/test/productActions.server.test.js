import { afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import prisma from '../app/db.server.js'
import { handleProductAction } from '../app/productActions.server.js'

describe('handleProductAction', () => {
  it('rejects an unknown intent with the existing response contract', async () => {
    const request = new Request('https://app.test/app/products', {
      method: 'POST',
      body: new URLSearchParams({ intent: 'unknown' }),
    })

    const admin = {
      graphql: async () => new Response(JSON.stringify({
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{ name: 'Pro', status: 'ACTIVE' }],
          },
        },
      })),
    }
    const response = await handleProductAction({ request, admin, shop: 'shop.test' })

    expect(response).toEqual({ error: 'Unknown action.' })
  })
})

describe('handleProductAction mark-fit-reviewed', () => {
  const shop = `review-${randomUUID().slice(0, 8)}.myshopify.com`
  const admin = {
    graphql: async () => new Response(JSON.stringify({
      data: { currentAppInstallation: { activeSubscriptions: [{ name: 'Pro', status: 'ACTIVE' }] } },
    })),
  }
  const post = (fields, forShop = shop) => handleProductAction({
    request: new Request('https://app.test/app', { method: 'POST', body: new URLSearchParams(fields) }),
    admin,
    shop: forShop,
  })
  afterAll(async () => {
    await prisma.modelAsset.deleteMany({ where: { shop } })
  })

  it('marks this shop\'s model reviewed from the Workspace', async () => {
    const asset = await prisma.modelAsset.create({
      data: { shop, storageRef: `${shop}/m.glb`, fitMetadata: {}, status: 'needs_manual' },
    })

    expect(await post({ intent: 'mark-fit-reviewed', modelAssetId: asset.id })).toEqual({ fitReviewed: true })
    expect((await prisma.modelAsset.findUnique({ where: { id: asset.id } })).fitReviewedAt).toBeInstanceOf(Date)
  })

  it('does not touch another shop\'s model', async () => {
    const asset = await prisma.modelAsset.create({
      data: { shop, storageRef: `${shop}/n.glb`, fitMetadata: {}, status: 'needs_manual' },
    })

    expect(await post({ intent: 'mark-fit-reviewed', modelAssetId: asset.id }, 'intruder.myshopify.com'))
      .toEqual({ error: 'That model no longer exists.' })
    expect((await prisma.modelAsset.findUnique({ where: { id: asset.id } })).fitReviewedAt).toBeNull()
  })
})
