import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  servable: true,
  freeAccess: false,
  reserveError: null,
  renderError: null,
  productError: null,
  released: [],
  adminShops: [],
  renderInput: null,
}))

vi.mock('../app/db.server.js', () => ({ default: {} }))
vi.mock('../app/shopify.server.js', () => ({
  unauthenticated: {
    admin: async (shop) => {
      h.adminShops.push(shop)
      return { admin: { shop } }
    },
  },
}))
vi.mock('../app/billing.server.js', () => ({
  hasFreeAccess: () => h.freeAccess,
  getShopSubscription: async () => ({}),
  isServable: () => h.servable,
}))
vi.mock('../app/photoTryon.server.js', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    photoTryonEnabled: (shop) => shop === 'qirpee-w4.myshopify.com',
    reserveAttempt: async () => {
      if (h.reserveError) throw h.reserveError
      return 'attempt-1'
    },
    releaseAttempt: async (_db, id) => {
      h.released.push(id)
    },
    productPhoto: async () => {
      if (h.productError) throw h.productError
      return { bytes: Buffer.from([0x89, 0x50]), contentType: 'image/png' }
    },
    renderPhotoTryon: async (input) => {
      h.renderInput = input
      if (h.renderError) throw h.renderError
      return Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    },
  }
})

const { action, loader } = await import('../app/routes/api.photo-tryon.jsx')

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])
const tag = (code) => Object.assign(new Error('internal detail'), { code })

function post({ shop = 'qirpee-w4.myshopify.com', productId = 'gid://shopify/Product/123', photo = JPEG } = {}) {
  const form = new FormData()
  if (shop !== null) form.append('shop', shop)
  if (productId !== null) form.append('productId', productId)
  if (photo !== null) form.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'photo.jpg')
  return action({ request: new Request('https://app.test/api/photo-tryon', { method: 'POST', body: form }) })
}

beforeEach(() => {
  Object.assign(h, {
    servable: true,
    freeAccess: false,
    reserveError: null,
    renderError: null,
    productError: null,
    released: [],
    adminShops: [],
    renderInput: null,
  })
})

describe('POST /api/photo-tryon', () => {
  it('returns the edited photo as an uncacheable JPEG', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(h.adminShops).toEqual(['qirpee-w4.myshopify.com'])
    expect(h.renderInput.selfieType).toBe('image/jpeg')
    expect(h.renderInput.productType).toBe('image/png')
    expect(h.released).toEqual([])
  })

  it('is off for every other store, before spending anything', async () => {
    const res = await post({ shop: 'xmcjg8-uh.myshopify.com' })
    expect(res.status).toBe(404)
    expect(h.adminShops).toEqual([])
    expect(h.renderInput).toBe(null)
  })

  it.each([
    [{ shop: 'not a shop' }],
    [{ shop: null }],
    [{ productId: '123' }],
    [{ productId: 'gid://shopify/Collection/1' }],
  ])('rejects a malformed request %j', async (overrides) => {
    expect((await post(overrides)).status).toBe(400)
  })

  it('rejects a missing photo or a file that is not an image', async () => {
    expect((await post({ photo: null })).status).toBe(400)
    expect((await post({ photo: new TextEncoder().encode('<svg onload=alert(1)>') })).status).toBe(400)
  })

  it('needs a servable subscription unless the shop is comped', async () => {
    h.servable = false
    expect((await post()).status).toBe(402)
    h.freeAccess = true
    expect((await post()).status).toBe(200)
  })

  it.each([
    ['CLIENT_LIMIT', 429],
    ['SHOP_LIMIT', 429],
  ])('maps %s to %i without calling OpenAI', async (code, status) => {
    h.reserveError = tag(code)
    const res = await post()
    expect(res.status).toBe(status)
    expect(h.renderInput).toBe(null)
  })

  it.each([
    ['PHOTO_REFUSED', 422],
    ['AI_FAILED', 502],
  ])('maps %s to %i and gives the try back', async (code, status) => {
    h.renderError = tag(code)
    const res = await post()
    expect(res.status).toBe(status)
    expect(h.released).toEqual(['attempt-1'])
    const body = await res.json()
    expect(body.code).toBe(code)
    expect(JSON.stringify(body)).not.toContain('internal detail')
  })

  it('reports a product without usable photos as unavailable, not as a bad selfie', async () => {
    h.productError = tag('BAD_PHOTO')
    const res = await post()
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('NO_PRODUCT_PHOTO')
    expect(h.released).toEqual(['attempt-1'])
  })

  it('fails closed to 500 for an uncoded error', async () => {
    h.renderError = new Error('raw failure')
    const res = await post()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('raw failure')
  })

  it('answers GET with 405', async () => {
    expect(loader().status).toBe(405)
  })
})
