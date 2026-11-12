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
  productVersions,
  renderAddChain,
  renderPhotoTryon,
  imageHash,
  signChainTicket,
  verifyChainTicket,
  reserveChainStep,
} from '../photoTryon.server'
import { isProductPhotoOff } from '../photoTryonControls.server'

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
  PRODUCT_OFF: 404,
  PRODUCT_NOT_FOUND: 404,
  NO_PRODUCT_PHOTO: 404,
  SUBSCRIPTION: 402,
  BAD_TICKET: 409,
  CLIENT_LIMIT: 429,
  SHOP_LIMIT: 429,
  AI_FAILED: 502,
}

const MESSAGES = {
  BAD_REQUEST: 'Something went wrong. Reload the page and try again.',
  BAD_PHOTO: 'Use a JPG, PNG or WebP photo.',
  PHOTO_REFUSED: "This photo couldn't be used. Try a clear, front-facing photo of your face.",
  NOT_ENABLED: 'Photo try-on is not available for this store.',
  PRODUCT_OFF: 'Photo try-on is not available for this product.',
  PRODUCT_NOT_FOUND: 'This product is not available for photo try-on.',
  NO_PRODUCT_PHOTO: 'This product is not available for photo try-on.',
  SUBSCRIPTION: 'Photo try-on is not available for this store.',
  BAD_TICKET: "We couldn't add the chain. Upload your photo again to try.",
  CLIENT_LIMIT: "You've reached today's limit of photo try-ons. Try again tomorrow.",
  SHOP_LIMIT: 'Photo try-on is busy right now. Try again later.',
  AI_FAILED: "We couldn't create your photo. Try again in a moment.",
}

const fail = (code, status = STATUS[code] ?? 500) =>
  Response.json({ code, error: MESSAGES[code] ?? 'Something went wrong. Try again.' }, { status })

const toClient = (version, image) => ({
  label: version.label,
  accessory: version.accessory,
  image: `data:image/jpeg;base64,${image.toString('base64')}`,
})

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
  // The merchant switched it off for this product (Workspace card).
  try {
    if (await isProductPhotoOff(db, shop, productId)) return fail('PRODUCT_OFF')
  } catch (error) {
    console.error('photo-tryon: product switch lookup failed', error)
    return fail('AI_FAILED', 503)
  }
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

  if (form.get('step') === 'chain') {
    return chainStep({ form, shop, productId, base: selfie, baseType: selfieType })
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
    // Usually one version; two for a product sold "Glasses Only" and
    // "Glasses + Chain". The chain version is made by adding the chain to this
    // glasses-only picture, so the glasses are identical in both. That step
    // takes as long again, so it is a second request (step=chain) the page
    // makes after showing this picture, carrying a ticket bound to it.
    const versions = await productVersions(admin, productId)
    const plain = versions.find((v) => !v.accessory)
    const chain = versions.find((v) => v.accessory)
    const firstVersion = plain ?? chain
    const first = await renderPhotoTryon({
      selfie,
      selfieType,
      product: firstVersion.bytes,
      productType: firstVersion.contentType,
      accessory: firstVersion.accessory,
    })
    const addChain = Boolean(plain && chain)
    return Response.json({
      version: toClient(firstVersion, first),
      pending: addChain ? [{ label: chain.label, accessory: true }] : [],
      ...(addChain ? { chainTicket: signChainTicket({ shop, productId, attemptId, hash: imageHash(first) }) } : {}),
    }, { headers: { 'Cache-Control': 'no-store' } })
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

/**
 * Second request for a chain product: add the chain to the glasses-only
 * picture the first request returned. The ticket proves this server made that
 * exact picture for this product moments ago, and it works once.
 */
async function chainStep({ form, shop, productId, base, baseType }) {
  if (baseType !== 'image/jpeg') return fail('BAD_TICKET')
  let claims
  try {
    claims = verifyChainTicket(form.get('ticket'), { shop, productId, hash: imageHash(base) })
  } catch (error) {
    return fail(error?.code === 'BAD_TICKET' ? 'BAD_TICKET' : 'BAD_REQUEST')
  }
  let stepId
  try {
    stepId = await reserveChainStep(db, { shop, attemptId: claims.a })
  } catch (error) {
    if (error?.code in STATUS) return fail(error.code)
    console.error('photo-tryon: chain reservation failed', error)
    return fail('AI_FAILED', 503)
  }
  try {
    const { admin } = await unauthenticated.admin(shop)
    const chain = (await productVersions(admin, productId)).find((v) => v.accessory)
    if (!chain) throw Object.assign(new Error('no chain version'), { code: 'NO_PRODUCT_PHOTO' })
    const image = await renderAddChain({ base, chain: chain.bytes, chainType: chain.contentType })
    return Response.json({ version: toClient(chain, image) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    await releaseAttempt(db, stepId)
    const code = error?.code === 'BAD_PHOTO' ? 'NO_PRODUCT_PHOTO' : error?.code
    if (code in STATUS) {
      if (STATUS[code] >= 500) console.error('photo-tryon chain step failed', code, error?.message)
      return fail(code)
    }
    console.error('photo-tryon chain step failed', error)
    return fail('AI_FAILED', 500)
  }
}
