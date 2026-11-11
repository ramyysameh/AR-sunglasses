import { createHash } from 'node:crypto'
import OpenAI, { toFile } from 'openai'
import { tagged } from './errors.server.js'
import { download } from './productPhotos.server.js'

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

export const PHOTO_TRYON_ACCESSORY_PROMPT = `Image 1 is a photo of a person. Image 2 shows a product: a pair of sunglasses with an eyewear chain attached. Image 2 may show them worn by a model; copy only the sunglasses and the chain, never the model.

Edit image 1 so the person is wearing exactly these sunglasses with this chain.
- Copy the sunglasses faithfully: frame shape, thickness, colour and finish, lens colour and darkness, metal parts, and any logo or text on the frame, in the same place. Do not invent or restyle anything.
- Copy the chain faithfully: its links, beads or charms, colour, material and thickness. Attach it to the tip of each temple behind the ears and let it hang naturally down and around the back of the neck, with realistic drape and gravity. Where the photo cuts off, let the chain leave the frame naturally.
- Size and place the sunglasses naturally for this face: centred on the nose bridge, lenses over the eyes, temples running back to the ears, following the head's angle. Match the photo's lighting, with soft shadows where the frame and chain touch the skin.
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

/**
 * Versions to render for a product (spec addendum 2026-11-12). Merchants sell
 * some frames alone and with a chain as variants of one product, e.g. a "Set"
 * option of "Glasses Only" / "1. Glasses + Chain", each variant with its own
 * photo. For such a product the shopper gets one picture per version; for any
 * other product, one picture from the product's main photo.
 */
const ACCESSORY = /chain|accessor|strap|cord|lanyard/i
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/
const IMAGE_URL = 'url(transform: { maxWidth: 2048, maxHeight: 2048, preferredContentType: JPG })'

export const PRODUCT_VERSIONS_QUERY = `#graphql
  query PhotoTryonVersions($id: ID!) {
    product(id: $id) {
      id
      options { name values }
      featuredMedia { ... on MediaImage { image { ${IMAGE_URL} } } }
      variants(first: 50) {
        nodes {
          selectedOptions { name value }
          media(first: 1) { nodes { ... on MediaImage { image { ${IMAGE_URL} } } } }
        }
      }
    }
  }`

// "1. Glasses + Chain" -> "Glasses + Chain"
export const versionLabel = (value) => String(value).replace(/^\s*\d+[.)]\s*/, '').trim()

/** Pure: product data -> [{ label, accessory, url }], plain version first. */
export function versionsFromProduct(product) {
  const mainUrl = product?.featuredMedia?.image?.url ?? null
  const option = (product?.options ?? []).find((o) => (o.values ?? []).some((v) => ACCESSORY.test(v)))
  if (!option) return mainUrl ? [{ label: null, accessory: false, url: mainUrl }] : []
  const variants = product.variants?.nodes ?? []
  const imageFor = (value) => {
    const variant = variants.find((v) => v.selectedOptions?.some((o) => o.name === option.name && o.value === value)
      && v.media?.nodes?.[0]?.image?.url)
    return variant?.media.nodes[0].image.url ?? null
  }
  const versions = option.values.map((value) => {
    const accessory = ACCESSORY.test(value)
    return { label: versionLabel(value), accessory, url: imageFor(value) ?? (accessory ? null : mainUrl) }
  }).filter((v) => v.url)
  versions.sort((a, b) => Number(a.accessory) - Number(b.accessory))
  // At most one plain and one accessory version: that is what the page shows.
  const plain = versions.find((v) => !v.accessory)
  const withAccessory = versions.find((v) => v.accessory)
  return [plain, withAccessory].filter(Boolean)
}

/** Versions with their photos downloaded (Shopify CDN only), via the shop's Admin API. */
export async function productVersions(admin, productId, fetchImpl = fetch) {
  if (!PRODUCT_GID.test(productId)) throw tagged('PRODUCT_NOT_FOUND', `not a product id: ${productId}`)
  const res = await admin.graphql(PRODUCT_VERSIONS_QUERY, { variables: { id: productId } })
  const product = (await res.json())?.data?.product
  if (!product) throw tagged('PRODUCT_NOT_FOUND', `product ${productId} not found`)
  const versions = versionsFromProduct(product)
  if (versions.length === 0) throw tagged('NO_PRODUCT_PHOTO', `product ${productId} has no photos`)
  return Promise.all(versions.map(async (version) => ({ ...version, ...(await download(version.url, fetchImpl)) })))
}

// OpenAI turns some photos down (no person, unsafe content). That's the
// shopper's photo, not an outage, so it gets its own code and message.
const isRefusal = (error) =>
  error?.status === 400 && /safety|moderation|content policy|rejected/i.test(`${error?.code ?? ''} ${error?.message ?? ''}`)

/**
 * Selfie + product photo -> JPEG bytes of the shopper wearing the glasses
 * (and the chain, for an accessory version).
 */
export async function renderPhotoTryon({ selfie, selfieType, product, productType, accessory = false }) {
  let response
  try {
    response = await getClient().images.edit({
      model: PHOTO_MODEL,
      image: [
        await toFile(selfie, `person.${EXT[selfieType]}`, { type: selfieType }),
        await toFile(product, `sunglasses.${EXT[productType]}`, { type: productType }),
      ],
      prompt: accessory ? PHOTO_TRYON_ACCESSORY_PROMPT : PHOTO_TRYON_PROMPT,
      size: 'auto',
      quality: 'medium',
      output_format: 'jpeg',
      // Two versions travel back in one JSON response; keep each well under
      // a megabyte so the pair stays far below Vercel's 4.5 MB response cap.
      output_compression: 82,
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
