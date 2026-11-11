import { createHash } from 'node:crypto'
import OpenAI, { toFile } from 'openai'
import { tagged } from './errors.server.js'
import { fetchProductImages, download } from './productPhotos.server.js'

/**
 * Photo try-on (spec 2026-11-11): a shopper uploads a selfie and OpenAI's image
 * editing model returns it with the product's sunglasses on their face.
 *
 * Built for one merchant, so it is OFF for every shop not listed in
 * PHOTO_TRYON_SHOPS. The theme block hides the button for other shops too, but
 * that is cosmetic -- this list is the lock, because every request costs money.
 *
 * Nothing the shopper sends is stored: the selfie and the result live only in
 * this request's memory. The PhotoTryon table holds a salted IP hash and a
 * timestamp per request, for the daily limits, and is trimmed to two days.
 */

const DEFAULT_SHOPS = 'qirpee-w4.myshopify.com,ar-tryon-dev-xbqbnjhd.myshopify.com'

export function parseShopList(spec) {
  return new Set(
    (spec ?? DEFAULT_SHOPS)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
}

const PHOTO_SHOPS = parseShopList(process.env.PHOTO_TRYON_SHOPS)

export function photoTryonEnabled(shop, shops = PHOTO_SHOPS) {
  return typeof shop === 'string' && shops.has(shop.toLowerCase())
}

const intFromEnv = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Per shopper (IP) and per shop, over the last 24 hours. Generous for a real
// shopper, small enough that one person can't run up the OpenAI bill.
export const LIMITS = {
  perClient: intFromEnv(process.env.PHOTO_TRYON_PER_CLIENT_DAILY, 5),
  perShop: intFromEnv(process.env.PHOTO_TRYON_PER_SHOP_DAILY, 300),
}

const DAY_MS = 24 * 60 * 60 * 1000
const RETENTION_MS = 2 * DAY_MS

export const PHOTO_MODEL = process.env.PHOTO_TRYON_MODEL || 'gpt-image-2.5-sunburst'

// Vercel caps a request body at 4.5 MB; the page shrinks photos well below this.
export const MAX_SELFIE_BYTES = 4 * 1024 * 1024

export const PHOTO_TRYON_PROMPT = `Image 1 is a photo of a person. Image 2 is a product photo of a pair of sunglasses.

Edit image 1 so the person is wearing exactly the sunglasses from image 2.
- Copy the sunglasses faithfully: frame shape, thickness, colour and finish, lens colour and darkness, metal parts, and any logo or text on the frame, in the same place. Do not invent or restyle anything.
- Size and place them naturally for this face: centred on the nose bridge, lenses over the eyes, temples running back to the ears, following the head's angle. Match the photo's lighting, with a soft shadow where the frame touches the face.
- If the person already wears glasses, replace them with these.
- Change nothing else: keep the person's face, identity, skin, expression, hair, clothing, pose, background, framing and image size exactly as they are.`

/** Salted hash of the shopper's address: enough to count, useless if leaked. */
export function clientKeyFor(request, salt = process.env.SHOPIFY_API_SECRET ?? '') {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const ip = forwarded || request.headers.get('x-real-ip') || 'unknown'
  return createHash('sha256').update(`${salt}:photo-tryon:${ip}`).digest('hex').slice(0, 32)
}

/** Real image type from the file's first bytes; the browser's label is not trusted. */
export function sniffImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

/**
 * Count the request against both limits and record it. Recorded BEFORE the
 * OpenAI call so parallel requests from one shopper all see each other; the
 * caller releases the row if the call fails, so failures don't use up a try.
 * Also trims rows past retention, which keeps the table tiny without a cron.
 */
export async function reserveAttempt(db, { shop, clientKey, now = new Date() }) {
  const since = new Date(now.getTime() - DAY_MS)
  const [byClient, byShop] = await Promise.all([
    db.photoTryon.count({ where: { clientKey, createdAt: { gte: since } } }),
    db.photoTryon.count({ where: { shop, createdAt: { gte: since } } }),
  ])
  if (byClient >= LIMITS.perClient) throw tagged('CLIENT_LIMIT', 'shopper daily limit reached')
  if (byShop >= LIMITS.perShop) throw tagged('SHOP_LIMIT', 'shop daily limit reached')
  const row = await db.photoTryon.create({ data: { shop, clientKey } })
  db.photoTryon
    .deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - RETENTION_MS) } } })
    .catch((error) => console.error('photo-tryon: retention trim failed', error))
  return row.id
}

export async function releaseAttempt(db, id) {
  try {
    await db.photoTryon.delete({ where: { id } })
  } catch (error) {
    console.error('photo-tryon: release failed', error)
  }
}

let client = null
function getClient() {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return client
}

/** Test seam: inject a fake client (null restores the real one). */
export function setPhotoClient(fake) {
  client = fake
}

/** The product's first photo, read through the shop's own Admin API. */
export async function productPhoto(admin, productId, fetchImpl = fetch) {
  const product = await fetchProductImages(admin, productId)
  const first = product.images[0]
  if (!first) throw tagged('NO_PRODUCT_PHOTO', `product ${productId} has no photos`)
  return download(first.url, fetchImpl)
}

// OpenAI turns some photos down (no person, unsafe content). That's the
// shopper's photo, not an outage, so it gets its own code and message.
const isRefusal = (error) =>
  error?.status === 400 && /safety|moderation|content policy|rejected/i.test(`${error?.code ?? ''} ${error?.message ?? ''}`)

/**
 * Selfie + product photo -> JPEG bytes of the shopper wearing the glasses.
 */
export async function renderPhotoTryon({ selfie, selfieType, product, productType }) {
  let response
  try {
    response = await getClient().images.edit({
      model: PHOTO_MODEL,
      image: [
        await toFile(selfie, `person.${EXT[selfieType]}`, { type: selfieType }),
        await toFile(product, `sunglasses.${EXT[productType]}`, { type: productType }),
      ],
      prompt: PHOTO_TRYON_PROMPT,
      size: 'auto',
      quality: 'medium',
      output_format: 'jpeg',
      n: 1,
    })
  } catch (error) {
    if (isRefusal(error)) throw tagged('PHOTO_REFUSED', error.message)
    throw tagged('AI_FAILED', error?.message ?? String(error))
  }
  const b64 = response?.data?.[0]?.b64_json
  if (!b64) throw tagged('AI_FAILED', 'no image in response')
  return Buffer.from(b64, 'base64')
}
