import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import { buildDoc } from '@artryon/calibration/test/helpers/buildDoc.js'
import prisma from '../app/db.server.js'

// Storage is object-backed (R2) in production; stub it with an in-memory store so
// this test exercises fetch→calibrate→store→persist without real object storage.
const storage = vi.hoisted(() => ({ objects: new Map() }))
vi.mock('../app/storage.server.js', () => ({
  saveModelGlb: async (ref, bytes) => {
    storage.objects.set(ref, Buffer.from(bytes))
  },
  readModelGlb: async (ref) => storage.objects.get(ref) ?? null,
  deleteModelGlb: async (ref) => {
    storage.objects.delete(ref)
  },
}))

const { registerModelByUrl } = await import('../app/models.server.js')

const URL_A = 'https://cdn.shopify.com/s/files/1/0001/registerModelByUrl-a.glb'
const URL_B = 'https://cdn.shopify.com/s/files/1/0001/registerModelByUrl-b.glb'
const SHOP = 'block-attr-test.myshopify.com'

const GOOD = [
  -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, 0.02,
  -0.069, 0, -0.13, 0.069, 0, -0.13, 0, -0.02, 0.02,
]

async function taggedGlbBytes() {
  const doc = buildDoc(GOOD, {
    AR_bridge: { x: 0, y: 0.024, z: 0.02 },
    AR_hinge_L: { x: -0.069, y: 0, z: -0.01 },
    AR_hinge_R: { x: 0.069, y: 0, z: -0.01 },
  })
  return new NodeIO().registerExtensions(KHRONOS_EXTENSIONS).writeBinary(doc)
}

function stubFetchReturning(bytes) {
  const spy = vi.fn(async () => new Response(bytes, { status: 200 }))
  vi.stubGlobal('fetch', spy)
  return spy
}

// Every fixture shop this file creates, so afterAll can remove exactly those.
//
// This matters more than usual: the tests run against the LIVE SHARED database.
// Cleaning up at the end of a test body does not run when that test fails, and
// an earlier version of this file leaked rows under a `not-installed-*` shop
// when a test failed mid-way. Deleting by prefix would be the easy fix and the
// wrong one -- a prefix filter can match rows we did not create. Tracking exact
// names cannot.
const fixtureShops = []
function trackShop(name) {
  fixtureShops.push(name)
  return name
}

async function installShop(name) {
  trackShop(name)
  await prisma.session.deleteMany({ where: { shop: name } })
  await prisma.session.create({
    data: { id: `sess-${name}`, shop: name, state: 'x', accessToken: 't' },
  })
  return name
}

// Registration now refuses a shop with no installed session, so the fixture
// shop needs one.
beforeAll(async () => {
  await installShop(SHOP)
})

afterAll(async () => {
  vi.unstubAllGlobals()
  storage.objects.clear()
  // Exact names only, never a pattern -- see the note on fixtureShops.
  for (const shop of fixtureShops) {
    await prisma.productMapping.deleteMany({ where: { shop } })
    await prisma.modelAsset.deleteMany({ where: { shop } })
    await prisma.session.deleteMany({ where: { shop } })
  }
})

describe('registerModelByUrl', () => {
  it('fetches, calibrates, stores, and persists a ModelAsset keyed by sourceUrl', async () => {
    const bytes = await taggedGlbBytes()
    const fetchSpy = stubFetchReturning(bytes)

    const res = await registerModelByUrl(prisma, URL_A, SHOP)

    expect(res.modelUrl).toMatch(/^\/models\/.+\.glb$/)
    expect(res.fitMetadata.version).toBe('eyewear-v1')
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const asset = await prisma.modelAsset.findFirst({ where: { sourceUrl: URL_A } })
    expect(asset).not.toBeNull()
    expect(asset.shop).toBe(SHOP)
    const stored = storage.objects.get(asset.storageRef)
    expect(stored).toBeDefined()
    expect(stored.length).toBeGreaterThan(0)
  })

  it('dedupes on the second call for the same URL (no re-fetch, one asset)', async () => {
    const bytes = await taggedGlbBytes()
    const fetchSpy = stubFetchReturning(bytes)

    const first = await registerModelByUrl(prisma, URL_B, SHOP)
    const second = await registerModelByUrl(prisma, URL_B, SHOP)

    expect(second.modelUrl).toBe(first.modelUrl)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const count = await prisma.modelAsset.count({ where: { sourceUrl: URL_B } })
    expect(count).toBe(1)
  })
})

describe('registerModelByUrl shop attribution', () => {
  // The suite above already left a (SHOP, URL_A) row behind (afterAll cleans up
  // once, at file end). These tests assert exact counts for SHOP/URL_A, so they
  // need a clean slate rather than inheriting that state.
  beforeAll(async () => {
    await prisma.modelAsset.deleteMany({ where: { shop: SHOP } })
  })

  it('refuses to register without a valid shop, so no unattributable row is created', async () => {
    // An unattributed row can never be erased by shop/redact. Rejecting is the
    // only safe outcome. The throw is now a tagged SHOP_INVALID rather than a
    // bare TypeError, so the route can map it to 400 without matching on prose.
    for (const bad of [undefined, null, '', 'not-a-shop', 123]) {
      await expect(registerModelByUrl(prisma, URL_A, bad)).rejects.toMatchObject({
        code: 'SHOP_INVALID',
      })
    }
    expect(await prisma.modelAsset.count({ where: { sourceUrl: URL_A } })).toBe(0)
  })

  it('purgeShopData erases a block-registered model', async () => {
    const bytes = await taggedGlbBytes()
    stubFetchReturning(bytes)
    await registerModelByUrl(prisma, URL_A, SHOP)
    expect(await prisma.modelAsset.count({ where: { shop: SHOP } })).toBe(1)

    const { purgeShopData } = await import('../app/webhooks.server.js')
    await purgeShopData(prisma, SHOP)

    // The whole point of this task.
    expect(await prisma.modelAsset.count({ where: { shop: SHOP } })).toBe(0)
  })
})

describe('registerModelByUrl security gates', () => {
  it('rejects a falsy shop BEFORE querying for a session', async () => {
    // SECURITY-CRITICAL. Prisma drops undefined filters, so
    // session.findFirst({ where: { shop: undefined } }) returns the FIRST
    // SESSION OF ANY SHOP -- the installed-shop check would pass for a request
    // with no shop at all. The shape guard is what prevents that, which makes
    // it part of the security control, not input tidying.
    //
    // Asserting the query never ran is the point: a bare rejects.toThrow()
    // would pass even if the throw came from somewhere after the query.
    const findFirst = vi.fn()
    const spyPrisma = {
      session: { findFirst },
      modelAsset: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn() },
    }

    for (const bad of [undefined, null, '', 'not-a-shop', 123]) {
      await expect(registerModelByUrl(spyPrisma, URL_A, bad)).rejects.toMatchObject({
        code: 'SHOP_INVALID',
      })
    }
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('rejects a shop with no installed session', async () => {
    // Tracked even though nothing should be created for it -- if the check
    // regresses, the row this test would then create must still be cleaned up.
    const stranger = trackShop(`not-installed-${randomUUID().slice(0, 8)}.myshopify.com`)
    await expect(registerModelByUrl(prisma, URL_A, stranger)).rejects.toMatchObject({
      code: 'SHOP_NOT_INSTALLED',
    })
    expect(await prisma.modelAsset.count({ where: { shop: stranger } })).toBe(0)
  })

  it('allows registration at the quota boundary and rejects past it', async () => {
    // Both sides of the boundary. Testing only the rejecting side would pass
    // against an off-by-one that locks merchants out one model early.
    const { MAX_MODELS_PER_SHOP } = await import('../app/models.server.js')
    const quotaShop = await installShop(`quota-${randomUUID().slice(0, 8)}.myshopify.com`)
    const FIRST = 'https://cdn.shopify.com/quota-first.glb'
    const SECOND = 'https://cdn.shopify.com/quota-second.glb'

    // One short of the limit.
    await prisma.modelAsset.createMany({
      data: Array.from({ length: MAX_MODELS_PER_SHOP - 1 }, (_, i) => ({
        shop: quotaShop,
        storageRef: `quota-${i}.glb`,
        fitMetadata: { version: 'eyewear-v1' },
      })),
    })

    stubFetchReturning(await taggedGlbBytes())

    // At MAX-1: succeeds, taking the shop to exactly MAX.
    const ok = await registerModelByUrl(prisma, FIRST, quotaShop)
    expect(ok.modelUrl).toMatch(/^\/models\/.+\.glb$/)
    expect(await prisma.modelAsset.count({ where: { shop: quotaShop } })).toBe(MAX_MODELS_PER_SHOP)

    // At MAX: rejects.
    await expect(registerModelByUrl(prisma, SECOND, quotaShop)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    })

    // Dedupe must still resolve for a shop at its limit, or a merchant who hits
    // the cap loses access to models they already registered.
    const resolved = await registerModelByUrl(prisma, FIRST, quotaShop)
    expect(resolved.modelUrl).toBe(ok.modelUrl)
    // No inline cleanup: afterAll removes every tracked shop, so a failure
    // above cannot leak rows into the shared database.
  })

  it('refuses a url that is not on the allowlisted CDN', async () => {
    // Its own installed shop, deliberately. SHOP cannot be reused here: the
    // purge test above calls purgeShopData(SHOP), which deletes SHOP's Session
    // row -- so this would fail with SHOP_NOT_INSTALLED before ever reaching
    // the url check, and would pass for entirely the wrong reason if the url
    // check were removed.
    const urlShop = await installShop(`urlcheck-${randomUUID().slice(0, 8)}.myshopify.com`)
    await expect(
      registerModelByUrl(prisma, 'https://evil.example.com/a.glb', urlShop),
    ).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' })
  })
})
