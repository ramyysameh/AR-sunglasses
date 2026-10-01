import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  shop: 'route-test.myshopify.com',
  plan: 'Starter',
  enabled: true,
  gen: {},
  presign: vi.fn(),
  deleteGlb: vi.fn(),
  unwrap: vi.fn(),
  glb: new Map(),
  rows: new Map(),
  products: { fetch: vi.fn(), import: vi.fn() },
  mapping: vi.fn(),
}))

vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: h.shop },
      admin: {
        graphql: async (query) => {
          if (query.includes('currentAppInstallation')) {
            return new Response(JSON.stringify({
              data: { currentAppInstallation: { activeSubscriptions: h.plan ? [{ name: h.plan, status: 'ACTIVE' }] : [] } },
            }))
          }
          return new Response(JSON.stringify({ data: { shop: { id: 'gid://shopify/Shop/7' } } }))
        },
      },
    }),
  },
}))
vi.mock('../app/db.server.js', () => ({
  default: { modelGeneration: { findUnique: async ({ where }) => h.rows.get(where.id) ?? null } },
}))
vi.mock('../app/storage.server.js', () => ({
  presignPhotoUpload: (...args) => h.presign(...args),
  readModelGlb: async (key) => h.glb.get(key) ?? null,
  deleteModelGlb: (...args) => h.deleteGlb(...args),
}))
vi.mock('../app/modelGenerator.server.js', () => ({
  unwrapWebhook: (...args) => h.unwrap(...args),
}))
vi.mock('../app/productPhotos.server.js', () => ({
  fetchProductImages: (...a) => h.products.fetch(...a),
  importProductPhotos: (...a) => h.products.import(...a),
}))
vi.mock('../app/aiProductMapping.server.js', () => ({
  addGeneratedModelToProduct: (...a) => h.mapping(...a),
}))
vi.mock('../app/generations.server.js', () => ({
  aiGenerationEnabled: () => h.enabled,
  assertCanStartGeneration: (...args) => h.gen.guard(...args),
  getAllowance: async () => ({ allowance: 10, used: 1, unlimited: false, freeRemaining: 9 }),
  listGenerations: (...args) => h.gen.list(...args),
  createGeneration: (...args) => h.gen.create(...args),
  saveGeneration: (...args) => h.gen.save(...args),
  discardGeneration: (...args) => h.gen.discard(...args),
  advanceByProviderJob: (...args) => h.gen.advance(...args),
  toClientGeneration: (g) => ({ id: g.id, status: g.status }),
}))

const api = await import('../app/routes/api.generations.jsx')
const glbRoute = await import('../app/routes/generations.$generationId[.]glb.jsx')
const webhook = await import('../app/routes/webhooks.openai.jsx')

function post(fields) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return { request: new Request('https://x/api/generations', { method: 'POST', body: fd }) }
}
const get = () => ({ request: new Request('https://x/api/generations') })
const tagged = (code) => Object.assign(new Error(code), { code })

beforeEach(() => {
  h.plan = 'Starter'
  h.enabled = true
  h.gen = { list: vi.fn(), create: vi.fn(), save: vi.fn(), discard: vi.fn(), advance: vi.fn(), guard: vi.fn() }
  h.presign.mockReset()
  h.deleteGlb.mockReset()
  h.unwrap.mockReset()
  h.glb.clear()
  h.rows.clear()
  h.products.fetch.mockReset()
  h.products.import.mockReset()
  h.mapping.mockReset()
})

describe('api.generations', () => {
  it('404s for shops the feature is not enabled for', async () => {
    h.enabled = false
    expect((await api.loader(get())).status).toBe(404)
    expect((await api.action(post({ intent: 'create' }))).status).toBe(404)
  })

  it('402s without an active plan', async () => {
    h.plan = null
    const res = await api.loader(get())
    expect(res.status).toBe(402)
    expect((await res.json()).error).toMatch(/no active subscription/i)
  })

  it('lists generations with the allowance', async () => {
    h.gen.list.mockResolvedValue([{ id: 'g1', status: 'ready' }])
    const body = await (await api.loader(get())).json()
    expect(body).toEqual({
      generations: [{ id: 'g1', status: 'ready' }],
      allowance: { allowance: 10, used: 1, unlimited: false, freeRemaining: 9 },
    })
    expect(h.gen.list.mock.calls[0][1]).toBe(h.shop)
  })

  it('presigns one shop-scoped upload per photo, after the cost guard passes', async () => {
    h.presign.mockImplementation(async ({ shop, contentType }) => ({ uploadUrl: `u-${contentType}`, storageRef: `generation-photos/${shop}/0a.${contentType.split('/')[1]}` }))
    const files = [{ type: 'image/jpeg', size: 1 }, { type: 'image/png', size: 2 }, { type: 'image/webp', size: 3 }]
    const body = await (await api.action(post({ intent: 'presign-photos', files: JSON.stringify(files) }))).json()
    expect(body.uploads.map((u) => u.uploadUrl)).toEqual(['u-image/jpeg', 'u-image/png', 'u-image/webp'])
    expect(h.presign).toHaveBeenCalledWith({ shop: h.shop, contentType: 'image/png', size: 2 })
    expect(h.gen.guard).toHaveBeenCalledTimes(1)
    expect(h.gen.guard.mock.calls[0][1]).toBe(h.shop)
  })

  it('refuses to presign (429) when the shop could not start a generation anyway', async () => {
    for (const code of ['TOO_MANY_RUNNING', 'DAILY_LIMIT']) {
      h.gen.guard.mockRejectedValue(tagged(code))
      const files = [{ type: 'image/jpeg', size: 1 }, { type: 'image/png', size: 2 }, { type: 'image/webp', size: 3 }]
      const res = await api.action(post({ intent: 'presign-photos', files: JSON.stringify(files) }))
      expect(res.status).toBe(429)
      expect((await res.json()).code).toBe(code)
    }
    expect(h.presign).not.toHaveBeenCalled()
  })

  it('rejects the wrong number of photos, or malformed JSON, with a 400', async () => {
    for (const files of [JSON.stringify([{ type: 'image/png', size: 1 }]), 'not json']) {
      const res = await api.action(post({ intent: 'presign-photos', files }))
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('BAD_PHOTOS')
    }
  })

  it('creates with the shop GID and parsed photo refs', async () => {
    h.gen.create.mockResolvedValue({ id: 'g2', status: 'running' })
    const refs = ['0a', '1b', '2c'].map((id) => `generation-photos/${h.shop}/${id}.jpg`)
    const body = await (await api.action(post({ intent: 'create', photoRefs: JSON.stringify(refs) }))).json()
    expect(body).toEqual({ generation: { id: 'g2', status: 'running' } })
    expect(h.gen.create.mock.calls[0][1]).toEqual({ shop: h.shop, shopGid: 'gid://shopify/Shop/7', photoRefs: refs, retryOf: null })
  })

  it('retries by generation id', async () => {
    h.gen.create.mockResolvedValue({ id: 'g3', status: 'running' })
    await api.action(post({ intent: 'retry', generationId: 'g1' }))
    expect(h.gen.create.mock.calls[0][1]).toMatchObject({ photoRefs: null, retryOf: 'g1' })
  })

  it('saves, passing the plan and whether the charge was accepted', async () => {
    h.gen.save.mockResolvedValue({ assetId: 'a1', paid: true })
    const body = await (await api.action(post({ intent: 'save', generationId: 'g1', acceptCharge: 'true' }))).json()
    expect(body).toEqual({ assetId: 'a1', paid: true })
    expect(h.gen.save.mock.calls[0][1]).toEqual({ shop: h.shop, generationId: 'g1', planName: 'Starter', acceptCharge: true })
  })

  it('maps known error codes to statuses and merchant copy', async () => {
    const cases = [
      ['CHARGE_NOT_CONFIRMED', 402], ['TOO_MANY_RUNNING', 429], ['DAILY_LIMIT', 429],
      ['RETRY_LIMIT', 409], ['NOT_READY', 409], ['NOT_FOUND', 404], ['GLB_MISSING', 409],
    ]
    for (const [code, status] of cases) {
      h.gen.save.mockRejectedValue(tagged(code))
      const res = await api.action(post({ intent: 'save', generationId: 'g1' }))
      expect(res.status).toBe(status)
      const body = await res.json()
      expect(body.code).toBe(code)
      expect(body.error).not.toBe(code)
    }
  })

  it('words the retry-limit message for both photo sources', async () => {
    h.gen.create.mockRejectedValue(tagged('RETRY_LIMIT'))
    const res = await api.action(post({ intent: 'retry', generationId: 'g1' }))
    expect((await res.json()).error).toBe("You've used all 3 retries for these photos. Start again with different photos.")
  })

  it('hides unexpected errors behind a generic 500', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      h.gen.discard.mockRejectedValue(new Error('prisma exploded at 0x1f'))
      const res = await api.action(post({ intent: 'discard', generationId: 'g1' }))
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'Something went wrong. Try again.' })
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })

  it('400s an unknown intent', async () => {
    expect((await api.action(post({ intent: 'bogus' }))).status).toBe(400)
  })
})

describe('product source', () => {
  it("lists a product's images as thumbnails only", async () => {
    h.products.fetch.mockResolvedValue({ productId: 'gid://shopify/Product/42', title: 'GRIPZ', handle: 'g', images: [{ id: 'm1', url: 'https://cdn.shopify.com/big.jpg', thumbnailUrl: 'https://cdn.shopify.com/t.jpg', altText: 'front' }] })
    const body = await (await api.action(post({ intent: 'product-images', productId: 'gid://shopify/Product/42' }))).json()
    expect(body).toEqual({ product: { id: 'gid://shopify/Product/42', title: 'GRIPZ' }, images: [{ id: 'm1', thumbnailUrl: 'https://cdn.shopify.com/t.jpg', altText: 'front' }] })
  })

  it('creates from a product: guard first, then import, then a product-sourced generation', async () => {
    const order = []
    h.gen.guard.mockImplementation(async () => { order.push('guard') })
    h.products.import.mockImplementation(async () => { order.push('import'); return { photoRefs: ['r1', 'r2', 'r3'], productId: 'gid://shopify/Product/42', title: 'GRIPZ', handle: 'gripz' } })
    h.gen.create.mockImplementation(async () => { order.push('create'); return { id: 'g9', status: 'running' } })
    const body = await (await api.action(post({ intent: 'create-from-product', productId: 'gid://shopify/Product/42', imageIds: JSON.stringify(['m1', 'm2', 'm3']) }))).json()
    expect(order).toEqual(['guard', 'import', 'create'])
    expect(h.products.import.mock.calls[0][0]).toMatchObject({ shop: h.shop, productId: 'gid://shopify/Product/42', imageIds: ['m1', 'm2', 'm3'] })
    expect(h.gen.create.mock.calls[0][1]).toMatchObject({ photoRefs: ['r1', 'r2', 'r3'], photoSource: 'product', productId: 'gid://shopify/Product/42', productTitle: 'GRIPZ', productHandle: 'gripz', shopGid: 'gid://shopify/Shop/7' })
    expect(body).toEqual({ generation: { id: 'g9', status: 'running' } })
  })

  it('maps product-sourced saves and leaves upload saves alone', async () => {
    h.gen.save.mockResolvedValue({ assetId: 'a1', paid: true, productId: 'gid://shopify/Product/42', productHandle: 'gripz' })
    h.mapping.mockResolvedValue({ mapped: false, reason: 'product_limit' })
    const res = await api.action(post({ intent: 'save', generationId: 'g1', acceptCharge: 'true' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ assetId: 'a1', paid: true })
    expect(body.mapping).toEqual({ mapped: false, reason: 'product_limit' })
    expect(h.mapping.mock.calls[0][0]).toMatchObject({ shop: h.shop, planName: 'Starter', productId: 'gid://shopify/Product/42', productHandle: 'gripz', modelAssetId: 'a1' })

    h.mapping.mockClear()
    h.gen.save.mockResolvedValue({ assetId: 'a2', paid: false, productId: null, productHandle: null })
    const plain = await (await api.action(post({ intent: 'save', generationId: 'g2' }))).json()
    expect(plain.mapping).toBeUndefined()
    expect(h.mapping).not.toHaveBeenCalled()
  })

  it('maps product errors to merchant copy', async () => {
    h.products.fetch.mockRejectedValue(Object.assign(new Error('x'), { code: 'PRODUCT_NOT_FOUND' }))
    const res = await api.action(post({ intent: 'product-images', productId: 'gid://shopify/Product/1' }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'That product is no longer available. Pick another one.', code: 'PRODUCT_NOT_FOUND' })
  })

  it('refuses create-from-product at the guard before importing anything', async () => {
    h.gen.guard.mockRejectedValue(tagged('DAILY_LIMIT'))
    const res = await api.action(post({ intent: 'create-from-product', productId: 'gid://shopify/Product/42', imageIds: JSON.stringify(['m1', 'm2', 'm3']) }))
    expect(res.status).toBe(429)
    expect(h.products.import).not.toHaveBeenCalled()
  })

  it('deletes the imported photos when the generation cannot be created', async () => {
    h.products.import.mockResolvedValue({ photoRefs: ['r1', 'r2', 'r3'], productId: 'gid://shopify/Product/42', title: 'GRIPZ', handle: 'gripz' })
    h.gen.create.mockRejectedValue(tagged('TOO_MANY_RUNNING'))
    const res = await api.action(post({ intent: 'create-from-product', productId: 'gid://shopify/Product/42', imageIds: JSON.stringify(['m1', 'm2', 'm3']) }))
    expect(res.status).toBe(429)
    expect(h.deleteGlb.mock.calls.map((c) => c[0])).toEqual(['r1', 'r2', 'r3'])
  })

  it('keeps the imported photos when create fails after the row may exist', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      h.products.import.mockResolvedValue({ photoRefs: ['r1', 'r2', 'r3'], productId: 'gid://shopify/Product/42', title: 'GRIPZ', handle: 'gripz' })
      h.gen.create.mockRejectedValue(new Error('connection reset after insert'))
      const res = await api.action(post({ intent: 'create-from-product', productId: 'gid://shopify/Product/42', imageIds: JSON.stringify(['m1', 'm2', 'm3']) }))
      expect(res.status).toBe(500)
      expect(h.deleteGlb).not.toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })

  it('still rethrows the create error when a cleanup delete fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      h.products.import.mockResolvedValue({ photoRefs: ['r1', 'r2'], productId: 'gid://shopify/Product/42', title: 'GRIPZ', handle: 'gripz' })
      h.gen.create.mockRejectedValue(tagged('TOO_MANY_RUNNING'))
      h.deleteGlb.mockRejectedValueOnce(new Error('s3 down'))
      const res = await api.action(post({ intent: 'create-from-product', productId: 'gid://shopify/Product/42', imageIds: JSON.stringify(['m1', 'm2', 'm3']) }))
      expect(res.status).toBe(429)
      expect(h.deleteGlb).toHaveBeenCalledTimes(2)
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })
})

describe('create-from-products', () => {
  beforeEach(() => {
    h.gen.guard = vi.fn(async () => {})
    h.deleteGlb.mockReset()
    h.products.import.mockReset()
    h.products.import.mockImplementation(async ({ productId }) => ({
      photoRefs: [`p/${productId}/1.jpg`, `p/${productId}/2.jpg`, `p/${productId}/3.jpg`],
      productId,
      title: `Title ${productId}`,
      handle: `handle-${productId}`,
    }))
    h.gen.create = vi.fn(async (_prisma, input) => ({ id: `gen-${input.productId}`, status: 'running' }))
  })

  const items = (ids) => JSON.stringify(ids.map((productId) => ({ productId, imageIds: ['i1', 'i2', 'i3'] })))

  it('creates one generation per product, in order', async () => {
    const res = await api.action(post({ intent: 'create-from-products', items: items(['A', 'B']) }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toEqual([
      { productId: 'A', generation: { id: 'gen-A', status: 'running' } },
      { productId: 'B', generation: { id: 'gen-B', status: 'running' } },
    ])
    expect(h.gen.create.mock.calls[1][1]).toMatchObject({ photoSource: 'product', productTitle: 'Title B', productHandle: 'handle-B' })
  })

  it('reports a failing product without stopping the others', async () => {
    h.products.import.mockImplementationOnce(async () => { throw tagged('PRODUCT_NOT_FOUND') })
    const body = await (await api.action(post({ intent: 'create-from-products', items: items(['A', 'B']) }))).json()
    expect(body.results[0]).toMatchObject({ productId: 'A', code: 'PRODUCT_NOT_FOUND', error: expect.any(String) })
    expect(body.results[1]).toMatchObject({ productId: 'B', generation: { id: 'gen-B' } })
  })

  it('hides raw exception text for an unexpected failure', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      h.products.import.mockImplementationOnce(async () => { throw new Error('secret db detail') })
      const body = await (await api.action(post({ intent: 'create-from-products', items: items(['A', 'B']) }))).json()
      expect(body.results[0]).toEqual({ productId: 'A', code: 'UNKNOWN', error: 'Something went wrong. Try again.' })
      expect(JSON.stringify(body)).not.toContain('secret db detail')
      expect(body.results[1]).toMatchObject({ productId: 'B', generation: { id: 'gen-B' } })
    } finally {
      logged.mockRestore()
    }
  })

  it('deletes imported photos when the row was never created', async () => {
    h.gen.create = vi.fn(async () => { throw tagged('DAILY_LIMIT') })
    const body = await (await api.action(post({ intent: 'create-from-products', items: items(['A']) }))).json()
    expect(body.results[0]).toMatchObject({ code: 'DAILY_LIMIT' })
    expect(h.deleteGlb.mock.calls.map(([ref]) => ref)).toEqual(['p/A/1.jpg', 'p/A/2.jpg', 'p/A/3.jpg'])
  })

  it('refuses malformed or non-array items with BAD_PRODUCTS', async () => {
    for (const raw of ['not json', JSON.stringify({ productId: 'A' }), '']) {
      const res = await api.action(post({ intent: 'create-from-products', items: raw }))
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('BAD_PRODUCTS')
    }
    expect(h.products.import).not.toHaveBeenCalled()
  })

  it('refuses duplicate productIds before importing anything', async () => {
    const res = await api.action(post({ intent: 'create-from-products', items: items(['A', 'B', 'A']) }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('BAD_PRODUCTS')
    expect(h.products.import).not.toHaveBeenCalled()
    expect(h.gen.create).not.toHaveBeenCalled()
  })

  it('imports all products before creating any generation', async () => {
    const order = []
    h.products.import.mockImplementation(async ({ productId }) => {
      order.push(`import-${productId}`)
      return { photoRefs: [`p/${productId}/1.jpg`], productId, title: productId, handle: productId }
    })
    h.gen.create = vi.fn(async (_prisma, input) => { order.push(`create-${input.productId}`); return { id: `gen-${input.productId}`, status: 'running' } })
    await api.action(post({ intent: 'create-from-products', items: items(['A', 'B']) }))
    expect(order).toEqual(['import-A', 'import-B', 'create-A', 'create-B'])
  })

  it('stops creating after the daily limit and deletes the remaining imported photos', async () => {
    let calls = 0
    h.gen.create = vi.fn(async (_prisma, input) => {
      calls += 1
      if (calls === 2) throw tagged('DAILY_LIMIT')
      return { id: `gen-${input.productId}`, status: 'running' }
    })
    const body = await (await api.action(post({ intent: 'create-from-products', items: items(['A', 'B', 'C']) }))).json()
    expect(h.gen.create).toHaveBeenCalledTimes(2)
    expect(body.results).toEqual([
      { productId: 'A', generation: { id: 'gen-A', status: 'running' } },
      { productId: 'B', code: 'DAILY_LIMIT', error: expect.any(String) },
      { productId: 'C', code: 'DAILY_LIMIT', error: expect.any(String) },
    ])
    expect(h.deleteGlb.mock.calls.map(([ref]) => ref)).toEqual(['p/B/1.jpg', 'p/B/2.jpg', 'p/B/3.jpg', 'p/C/1.jpg', 'p/C/2.jpg', 'p/C/3.jpg'])
  })

  it('keeps the photos when create fails after the row may exist, and reports UNKNOWN', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      h.gen.create = vi.fn(async () => { throw new Error('connection reset after insert') })
      const body = await (await api.action(post({ intent: 'create-from-products', items: items(['A']) }))).json()
      expect(body.results).toEqual([{ productId: 'A', code: 'UNKNOWN', error: 'Something went wrong. Try again.' }])
      expect(h.deleteGlb).not.toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })

  it('refuses an empty list or more than 5 products', async () => {
    for (const ids of [[], ['1', '2', '3', '4', '5', '6']]) {
      const res = await api.action(post({ intent: 'create-from-products', items: items(ids) }))
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('BAD_PRODUCTS')
    }
  })

  it('checks the daily limit before importing anything', async () => {
    h.gen.guard = vi.fn(async () => { throw tagged('DAILY_LIMIT') })
    const res = await api.action(post({ intent: 'create-from-products', items: items(['A']) }))
    expect(res.status).toBe(429)
    expect(h.products.import).not.toHaveBeenCalled()
  })
})

describe('generations/:id.glb', () => {
  it('serves a ready model without caching, and 404s anything else', async () => {
    h.rows.set('g1', { id: 'g1', status: 'ready', glbRef: 'generations/g1.glb' })
    h.rows.set('g2', { id: 'g2', status: 'saved', glbRef: null })
    h.glb.set('generations/g1.glb', Buffer.from('glb'))
    const ok = await glbRoute.loader({ params: { generationId: 'g1' } })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Content-Type')).toBe('model/gltf-binary')
    expect(ok.headers.get('Cache-Control')).toBe('private, no-store')
    expect((await glbRoute.loader({ params: { generationId: 'g2' } })).status).toBe(404)
    expect((await glbRoute.loader({ params: { generationId: 'nope' } })).status).toBe(404)
  })
})

describe('webhooks/openai', () => {
  const hook = (body = '{}') => ({ request: new Request('https://x/webhooks/openai', { method: 'POST', body, headers: { 'webhook-id': 'w1' } }) })

  it('400s a bad signature, logs why (message only), and advances nothing', async () => {
    h.unwrap.mockRejectedValue(new Error('invalid'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect((await webhook.action(hook('{"secret":"body"}'))).status).toBe(400)
      expect(warn).toHaveBeenCalledWith('OpenAI webhook rejected', 'invalid')
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret')
    } finally {
      warn.mockRestore()
    }
    expect(h.gen.advance).not.toHaveBeenCalled()
  })

  it('ignores (200) a finished event without a response id, and warns', async () => {
    h.unwrap.mockResolvedValue({ type: 'response.completed', data: {} })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const res = await webhook.action(hook())
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('ignored')
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
    expect(h.gen.advance).not.toHaveBeenCalled()
  })

  it('advances the generation for a finished job, passing the raw body and headers', async () => {
    h.unwrap.mockResolvedValue({ type: 'response.completed', data: { id: 'resp_9' } })
    h.gen.advance.mockResolvedValue({ id: 'g1' })
    const res = await webhook.action(hook('{"raw":true}'))
    expect(res.status).toBe(200)
    expect(h.unwrap).toHaveBeenCalledWith('{"raw":true}', expect.objectContaining({ 'webhook-id': 'w1' }))
    expect(h.gen.advance.mock.calls[0][1]).toBe('resp_9')
  })

  it('500s when advancing fails so OpenAI retries, and ignores other event types', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      h.unwrap.mockResolvedValue({ type: 'response.failed', data: { id: 'resp_9' } })
      h.gen.advance.mockRejectedValue(new Error('db down'))
      expect((await webhook.action(hook())).status).toBe(500)
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }

    h.unwrap.mockResolvedValue({ type: 'batch.completed', data: { id: 'b1' } })
    h.gen.advance.mockReset()
    expect((await webhook.action(hook())).status).toBe(200)
    expect(h.gen.advance).not.toHaveBeenCalled()
  })
})
