import { describe, it, expect, beforeEach, vi } from 'vitest'

const store = vi.hoisted(() => ({ saved: new Map(), deleted: [], failSave: false }))
vi.mock('../app/storage.server.js', () => ({
  MAX_PHOTO_BYTES: 10 * 1024 * 1024,
  newPhotoRef: (shop, type) => `generation-photos/${shop}/${store.saved.size + store.deleted.length}-${Math.random().toString(16).slice(2, 8)}.${type === 'image/png' ? 'png' : 'jpg'}`,
  savePhoto: async (key, bytes, type) => {
    if (store.failSave) throw new Error('s3 down')
    store.saved.set(key, { bytes, type })
  },
  deleteModelGlb: async (key) => { store.deleted.push(key); store.saved.delete(key) },
}))

const { fetchProductImages, importProductPhotos, PRODUCT_IMAGES_QUERY } = await import('../app/productPhotos.server.js')

const SHOP = 'gen-test.myshopify.com'
const PRODUCT = 'gid://shopify/Product/42'
const img = (n, host = 'cdn.shopify.com') => ({
  id: `gid://shopify/MediaImage/${n}`,
  mediaContentType: 'IMAGE',
  image: { url: `https://${host}/s/files/p${n}.jpg?width=2048`, thumbnail: `https://${host}/s/files/p${n}.jpg?width=300`, altText: `angle ${n}` },
})

function adminFor(product) {
  const calls = []
  return {
    calls,
    graphql: async (query, options) => {
      calls.push({ query, options })
      return new Response(JSON.stringify({ data: { product } }))
    },
  }
}

const okFetch = (type = 'image/jpeg', body = 'jpegbytes') => vi.fn(async (url) => new Response(body, { status: 200, headers: { 'content-type': type } }))

beforeEach(() => {
  store.saved.clear()
  store.deleted.length = 0
  store.failSave = false
})

describe('fetchProductImages', () => {
  it('returns the product and only its images, asking for the product by id', async () => {
    const admin = adminFor({
      id: PRODUCT, title: 'GRIPZ Pelmo', handle: 'gripz-pelmo',
      media: { nodes: [img(1), { id: 'gid://shopify/Video/9', mediaContentType: 'VIDEO' }, img(2)] },
    })
    const result = await fetchProductImages(admin, PRODUCT)
    expect(admin.calls[0].query).toBe(PRODUCT_IMAGES_QUERY)
    expect(admin.calls[0].options).toEqual({ variables: { id: PRODUCT } })
    expect(result).toEqual({
      productId: PRODUCT, title: 'GRIPZ Pelmo', handle: 'gripz-pelmo',
      images: [
        { id: 'gid://shopify/MediaImage/1', url: 'https://cdn.shopify.com/s/files/p1.jpg?width=2048', thumbnailUrl: 'https://cdn.shopify.com/s/files/p1.jpg?width=300', altText: 'angle 1' },
        { id: 'gid://shopify/MediaImage/2', url: 'https://cdn.shopify.com/s/files/p2.jpg?width=2048', thumbnailUrl: 'https://cdn.shopify.com/s/files/p2.jpg?width=300', altText: 'angle 2' },
      ],
    })
  })

  it('refuses malformed ids without calling Shopify, and missing products', async () => {
    const admin = adminFor(null)
    await expect(fetchProductImages(admin, 'gid://shopify/Order/1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(admin.calls).toHaveLength(0)
    await expect(fetchProductImages(admin, PRODUCT)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('importProductPhotos', () => {
  const product = { id: PRODUCT, title: 'GRIPZ Pelmo', handle: 'gripz-pelmo', media: { nodes: [img(1), img(2), img(3), img(4), img(5)] } }
  const ids = (...n) => n.map((k) => `gid://shopify/MediaImage/${k}`)

  it('downloads the ticked images from the CDN and stores them as shop photo keys', async () => {
    const fetchImpl = okFetch()
    const result = await importProductPhotos({ admin: adminFor(product), shop: SHOP, productId: PRODUCT, imageIds: ids(2, 4, 5), fetchImpl })
    expect(fetchImpl.mock.calls.map(([u]) => u)).toEqual([
      'https://cdn.shopify.com/s/files/p2.jpg?width=2048',
      'https://cdn.shopify.com/s/files/p4.jpg?width=2048',
      'https://cdn.shopify.com/s/files/p5.jpg?width=2048',
    ])
    expect(result.photoRefs).toHaveLength(3)
    expect(result).toMatchObject({ productId: PRODUCT, title: 'GRIPZ Pelmo', handle: 'gripz-pelmo' })
    for (const ref of result.photoRefs) expect(store.saved.get(ref).type).toBe('image/jpeg')
  })

  it('needs 3 or 4 distinct images that belong to the product', async () => {
    const run = (imageIds) => importProductPhotos({ admin: adminFor(product), shop: SHOP, productId: PRODUCT, imageIds, fetchImpl: okFetch() })
    await expect(run(ids(1, 2))).rejects.toMatchObject({ code: 'BAD_PHOTOS' })
    await expect(run(ids(1, 2, 3, 4, 5))).rejects.toMatchObject({ code: 'BAD_PHOTOS' })
    await expect(run(ids(1, 1, 2))).rejects.toMatchObject({ code: 'BAD_PHOTOS' })
    await expect(run([...ids(1, 2), 'gid://shopify/MediaImage/999'])).rejects.toMatchObject({ code: 'BAD_PHOTOS' })
    expect(store.saved.size).toBe(0)
  })

  it('refuses images not served from cdn.shopify.com', async () => {
    const evil = { ...product, media: { nodes: [img(1), img(2), img(3, 'evil.example.com')] } }
    await expect(importProductPhotos({ admin: adminFor(evil), shop: SHOP, productId: PRODUCT, imageIds: ids(1, 2, 3), fetchImpl: okFetch() }))
      .rejects.toMatchObject({ code: 'BAD_PHOTO' })
  })

  it('refuses non-image content, oversize bodies and failed downloads, and cleans up what it stored', async () => {
    const admin = () => adminFor(product)
    await expect(importProductPhotos({ admin: admin(), shop: SHOP, productId: PRODUCT, imageIds: ids(1, 2, 3), fetchImpl: okFetch('text/html') }))
      .rejects.toMatchObject({ code: 'BAD_PHOTO' })

    let n = 0
    const thirdFails = vi.fn(async () => (++n === 3 ? new Response('nope', { status: 500 }) : new Response('jpg', { status: 200, headers: { 'content-type': 'image/jpeg' } })))
    await expect(importProductPhotos({ admin: admin(), shop: SHOP, productId: PRODUCT, imageIds: ids(1, 2, 3), fetchImpl: thirdFails }))
      .rejects.toMatchObject({ code: 'BAD_PHOTO' })
    expect(store.deleted).toHaveLength(2)
    expect(store.saved.size).toBe(0)

    const huge = vi.fn(async () => new Response('x', { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(11 * 1024 * 1024) } }))
    await expect(importProductPhotos({ admin: admin(), shop: SHOP, productId: PRODUCT, imageIds: ids(1, 2, 3), fetchImpl: huge }))
      .rejects.toMatchObject({ code: 'BAD_PHOTO' })

    const rejecting = vi.fn(async () => { throw new Error('ECONNRESET') })
    await expect(importProductPhotos({ admin: admin(), shop: SHOP, productId: PRODUCT, imageIds: ids(1, 2, 3), fetchImpl: rejecting }))
      .rejects.toMatchObject({ code: 'BAD_PHOTO' })
  })

  it('cleans up stored photos when storage itself fails', async () => {
    store.failSave = true
    await expect(importProductPhotos({ admin: adminFor(product), shop: SHOP, productId: PRODUCT, imageIds: ids(1, 2, 3), fetchImpl: okFetch() }))
      .rejects.toThrow('s3 down')
  })
})
