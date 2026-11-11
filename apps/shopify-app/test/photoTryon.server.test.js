import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parseShopList,
  photoTryonEnabled,
  clientKeyFor,
  sniffImageType,
  reserveAttempt,
  releaseAttempt,
  renderPhotoTryon,
  setPhotoClient,
  LIMITS,
  PHOTO_TRYON_PROMPT,
} from '../app/photoTryon.server.js'

// In-memory PhotoTryon table: just the calls reserveAttempt/releaseAttempt make.
function fakeDb(rows = []) {
  const table = {
    rows,
    async count({ where }) {
      return rows.filter((r) =>
        Object.entries(where).every(([k, v]) => (k === 'createdAt' ? r.createdAt >= v.gte : r[k] === v)),
      ).length
    },
    async create({ data }) {
      const row = { id: `id-${rows.length + 1}`, createdAt: new Date(), ...data }
      rows.push(row)
      return row
    },
    async delete({ where }) {
      const i = rows.findIndex((r) => r.id === where.id)
      if (i < 0) throw new Error('not found')
      rows.splice(i, 1)
    },
    deleteMany: vi.fn(async ({ where }) => {
      const before = rows.length
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].createdAt < where.createdAt.lt) rows.splice(i, 1)
      return { count: before - rows.length }
    }),
  }
  return { photoTryon: table }
}

const NOW = new Date('2026-11-11T12:00:00Z')
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600_000)

describe('shop allowlist', () => {
  it('defaults to the requesting merchant only', () => {
    const shops = parseShopList(undefined)
    expect(photoTryonEnabled('qirpee-w4.myshopify.com', shops)).toBe(true)
    expect(photoTryonEnabled('QIRPEE-W4.myshopify.com', shops)).toBe(true)
    expect(photoTryonEnabled('xmcjg8-uh.myshopify.com', shops)).toBe(false)
  })

  it('takes a comma-separated override and rejects non-strings', () => {
    const shops = parseShopList(' a.myshopify.com , b.myshopify.com,')
    expect(photoTryonEnabled('b.myshopify.com', shops)).toBe(true)
    expect(photoTryonEnabled('qirpee-w4.myshopify.com', shops)).toBe(false)
    expect(photoTryonEnabled(undefined, shops)).toBe(false)
  })

  it('an empty override turns the feature off everywhere', () => {
    expect(parseShopList('').size).toBe(0)
  })
})

describe('clientKeyFor', () => {
  const req = (headers) => new Request('https://app.test/api/photo-tryon', { headers })

  it('hashes the first forwarded address, never returning the raw IP', () => {
    const key = clientKeyFor(req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }), 'salt')
    expect(key).toMatch(/^[0-9a-f]{32}$/)
    expect(key).not.toContain('203')
    expect(key).toBe(clientKeyFor(req({ 'x-forwarded-for': '203.0.113.9' }), 'salt'))
  })

  it('gives different shoppers and different salts different keys', () => {
    const a = clientKeyFor(req({ 'x-forwarded-for': '203.0.113.9' }), 'salt')
    expect(clientKeyFor(req({ 'x-forwarded-for': '203.0.113.10' }), 'salt')).not.toBe(a)
    expect(clientKeyFor(req({ 'x-forwarded-for': '203.0.113.9' }), 'other')).not.toBe(a)
  })
})

describe('sniffImageType', () => {
  it('recognises JPEG, PNG and WebP by their bytes', () => {
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(sniffImageType(Buffer.from('RIFF0000WEBPVP8 ', 'latin1'))).toBe('image/webp')
  })

  it('rejects anything else, whatever it claims to be', () => {
    expect(sniffImageType(Buffer.from('<svg></svg>'))).toBe(null)
    expect(sniffImageType(Buffer.from('GIF89a'))).toBe(null)
    expect(sniffImageType(Buffer.alloc(0))).toBe(null)
  })
})

describe('reserveAttempt', () => {
  const shop = 'qirpee-w4.myshopify.com'

  it('records the attempt when under both limits', async () => {
    const db = fakeDb()
    const id = await reserveAttempt(db, { shop, clientKey: 'k1', now: NOW })
    expect(db.photoTryon.rows).toHaveLength(1)
    expect(db.photoTryon.rows[0]).toMatchObject({ id, shop, clientKey: 'k1' })
  })

  it('stops a shopper at the daily limit, counting only the last 24 hours', async () => {
    const rows = [
      ...Array.from({ length: LIMITS.perClient }, () => ({ shop, clientKey: 'k1', createdAt: hoursAgo(1) })),
    ]
    await expect(reserveAttempt(fakeDb(rows), { shop, clientKey: 'k1', now: NOW })).rejects.toMatchObject({ code: 'CLIENT_LIMIT' })

    const old = Array.from({ length: LIMITS.perClient }, () => ({ shop, clientKey: 'k1', createdAt: hoursAgo(25) }))
    await expect(reserveAttempt(fakeDb(old), { shop, clientKey: 'k1', now: NOW })).resolves.toBeTruthy()
  })

  it('other shoppers are unaffected by one shopper hitting the limit', async () => {
    const rows = Array.from({ length: LIMITS.perClient }, () => ({ shop, clientKey: 'k1', createdAt: hoursAgo(1) }))
    await expect(reserveAttempt(fakeDb(rows), { shop, clientKey: 'k2', now: NOW })).resolves.toBeTruthy()
  })

  it('stops the whole shop at its daily cap', async () => {
    const rows = Array.from({ length: LIMITS.perShop }, (_, i) => ({ shop, clientKey: `c${i}`, createdAt: hoursAgo(2) }))
    await expect(reserveAttempt(fakeDb(rows), { shop, clientKey: 'new', now: NOW })).rejects.toMatchObject({ code: 'SHOP_LIMIT' })
  })

  it('trims rows older than two days', async () => {
    const db = fakeDb([{ id: 'old', shop, clientKey: 'k9', createdAt: hoursAgo(49) }])
    await reserveAttempt(db, { shop, clientKey: 'k1', now: NOW })
    await Promise.resolve()
    expect(db.photoTryon.deleteMany).toHaveBeenCalledWith({ where: { createdAt: { lt: hoursAgo(48) } } })
    expect(db.photoTryon.rows.map((r) => r.id)).not.toContain('old')
  })

  it('releaseAttempt gives the try back and never throws', async () => {
    const db = fakeDb()
    const id = await reserveAttempt(db, { shop, clientKey: 'k1', now: NOW })
    await releaseAttempt(db, id)
    expect(db.photoTryon.rows).toHaveLength(0)
    await expect(releaseAttempt(db, 'missing')).resolves.toBeUndefined()
  })
})

describe('renderPhotoTryon', () => {
  afterEach(() => setPhotoClient(null))
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
  const input = { selfie: jpeg, selfieType: 'image/jpeg', product: png, productType: 'image/png' }

  it('sends the selfie first, then the product photo, and returns the image bytes', async () => {
    const edit = vi.fn(async () => ({ data: [{ b64_json: Buffer.from('result').toString('base64') }] }))
    setPhotoClient({ images: { edit } })
    const out = await renderPhotoTryon(input)
    expect(out.toString()).toBe('result')
    const body = edit.mock.calls[0][0]
    expect(body.prompt).toBe(PHOTO_TRYON_PROMPT)
    expect(body.image.map((f) => f.name)).toEqual(['person.jpg', 'sunglasses.png'])
    expect(body.output_format).toBe('jpeg')
    expect(body).not.toHaveProperty('input_fidelity')
  })

  it('tags a safety refusal separately from an outage', async () => {
    setPhotoClient({ images: { edit: async () => { throw Object.assign(new Error('Your request was rejected by the safety system'), { status: 400 }) } } })
    await expect(renderPhotoTryon(input)).rejects.toMatchObject({ code: 'PHOTO_REFUSED' })

    setPhotoClient({ images: { edit: async () => { throw Object.assign(new Error('upstream'), { status: 500 }) } } })
    await expect(renderPhotoTryon(input)).rejects.toMatchObject({ code: 'AI_FAILED' })
  })

  it('treats an empty response as a failure', async () => {
    setPhotoClient({ images: { edit: async () => ({ data: [] }) } })
    await expect(renderPhotoTryon(input)).rejects.toMatchObject({ code: 'AI_FAILED' })
  })
})
