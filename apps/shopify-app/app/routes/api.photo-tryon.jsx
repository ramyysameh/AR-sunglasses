import { Buffer } from 'node:buffer'
import db from '../db.server'
import { unauthenticated } from '../shopify.server'
import { getShopSubscription, isServable, hasFreeAccess } from '../billing.server'
import {
  photoTryonEnabled,
  clientKeyFor,
  sniffImageType,
  MAX_SELFIE_BYTES,
  reserveAttempt,
  releaseAttempt,
  productPhoto,
  renderPhotoTryon,
} from '../photoTryon.server'

// Public endpoint for the photo try-on page (public/photo-tryon/index.html),
// which the theme block opens in an iframe served by this app, so the request
// is same-origin and needs no CORS. Shoppers aren't logged in to anything, so
// the guards are: the shop allowlist, the shop's subscription, and the daily
// limits per shopper and per shop. The product photo is looked up here through
// the shop's own Admin API -- the caller only names the product.

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/

const STATUS = {
  BAD_REQUEST: 400,
  BAD_PHOTO: 400,
  PHOTO_REFUSED: 422,
  NOT_ENABLED: 404,
  PRODUCT_NOT_FOUND: 404,
  NO_PRODUCT_PHOTO: 404,
  SUBSCRIPTION: 402,
  CLIENT_LIMIT: 429,
  SHOP_LIMIT: 429,
  AI_FAILED: 502,
}

const MESSAGES = {
  BAD_REQUEST: 'Something went wrong. Reload the page and try again.',
  BAD_PHOTO: 'Use a JPG, PNG or WebP photo.',
  PHOTO_REFUSED: "This photo couldn't be used. Try a clear, front-facing photo of your face.",
  NOT_ENABLED: 'Photo try-on is not available for this store.',
  PRODUCT_NOT_FOUND: 'This product is not available for photo try-on.',
  NO_PRODUCT_PHOTO: 'This product is not available for photo try-on.',
  SUBSCRIPTION: 'Photo try-on is not available for this store.',
  CLIENT_LIMIT: "You've reached today's limit of photo try-ons. Try again tomorrow.",
  SHOP_LIMIT: 'Photo try-on is busy right now. Try again later.',
  AI_FAILED: "We couldn't create your photo. Try again in a moment.",
}

const fail = (code, status = STATUS[code] ?? 500) =>
  Response.json({ code, error: MESSAGES[code] ?? 'Something went wrong. Try again.' }, { status })

export const loader = () => new Response('Method not allowed', { status: 405 })

export const action = async ({ request }) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const declared = Number(request.headers.get('content-length'))
  if (declared > MAX_SELFIE_BYTES + 64 * 1024) return fail('BAD_PHOTO', 413)

  let form
  try {
    form = await request.formData()
  } catch {
    return fail('BAD_REQUEST')
  }
  const shop = String(form.get('shop') ?? '').toLowerCase()
  const productId = String(form.get('productId') ?? '')
  const photo = form.get('photo')
  if (!SHOP_DOMAIN.test(shop) || !PRODUCT_GID.test(productId)) return fail('BAD_REQUEST')
  if (!photoTryonEnabled(shop)) return fail('NOT_ENABLED')
  if (!photo || typeof photo.arrayBuffer !== 'function') return fail('BAD_PHOTO')
  if (photo.size > MAX_SELFIE_BYTES) return fail('BAD_PHOTO', 413)

  const selfie = Buffer.from(await photo.arrayBuffer())
  const selfieType = sniffImageType(selfie)
  if (!selfieType) return fail('BAD_PHOTO')

  // Same paid-feature gate as the live try-on (api.tryon-config).
  if (!hasFreeAccess(shop)) {
    try {
      if (!isServable(await getShopSubscription(db, shop), new Date())) return fail('SUBSCRIPTION')
    } catch (error) {
      console.error('photo-tryon: subscription lookup failed', error)
      return fail('AI_FAILED', 503)
    }
  }

  let attemptId
  try {
    attemptId = await reserveAttempt(db, { shop, clientKey: clientKeyFor(request) })
  } catch (error) {
    if (error?.code in STATUS) return fail(error.code)
    console.error('photo-tryon: limit check failed', error)
    return fail('AI_FAILED', 503)
  }

  try {
    const { admin } = await unauthenticated.admin(shop)
    const product = await productPhoto(admin, productId)
    const image = await renderPhotoTryon({
      selfie,
      selfieType,
      product: product.bytes,
      productType: product.contentType,
    })
    return new Response(image, {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    await releaseAttempt(db, attemptId)
    const code = error?.code === 'BAD_PHOTO' ? 'NO_PRODUCT_PHOTO' : error?.code
    if (code in STATUS) {
      if (STATUS[code] >= 500) console.error('photo-tryon failed', code, error?.message)
      return fail(code)
    }
    console.error('photo-tryon failed', error)
    return fail('AI_FAILED', 500)
  }
}
