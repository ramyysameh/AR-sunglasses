import { authenticate } from '../shopify.server'
import prisma from '../db.server'
import { getActivePlanName } from '../billing.server'
import { presignPhotoUpload, deleteModelGlb } from '../storage.server'
import {
  aiGenerationEnabled,
  assertCanStartGeneration,
  remainingToday,
  getAllowance,
  listGenerations,
  createGeneration,
  saveGeneration,
  discardGeneration,
  toClientGeneration,
} from '../generations.server'
import { fetchProductImages, importProductPhotos } from '../productPhotos.server'
import { addGeneratedModelToProduct } from '../aiProductMapping.server'

// Resource route (no default export), for the same reason as api.model-upload:
// fetch() + json() needs a real JSON Response, not the rendered document.
// App Bridge attaches the session token to same-origin relative fetches.

const STATUS_BY_CODE = {
  BAD_PHOTOS: 400,
  BAD_PHOTO: 400,
  BAD_PRODUCTS: 400,
  NOT_FOUND: 404,
  PRODUCT_NOT_FOUND: 404,
  NOT_RETRYABLE: 409,
  NOT_READY: 409,
  RETRY_LIMIT: 409,
  GLB_MISSING: 409,
  CHARGE_NOT_CONFIRMED: 402,
  TOO_MANY_RUNNING: 429,
  DAILY_LIMIT: 429,
}

// Thrown by createGeneration before it creates the row.
const PRE_INSERT_CODES = new Set(['BAD_PHOTOS', 'TOO_MANY_RUNNING', 'DAILY_LIMIT'])

const MESSAGES = {
  BAD_PHOTOS: 'Choose 3 or 4 photos (front and sides work best).',
  BAD_PRODUCTS: 'Choose 1 to 5 products.',
  BAD_PHOTO: "One of the photos couldn't be used. Use JPG, PNG or WebP photos of 10 MB or less, or choose different product photos.",
  NOT_FOUND: 'That model is no longer available. Refresh the page.',
  PRODUCT_NOT_FOUND: 'That product is no longer available. Pick another one.',
  NOT_RETRYABLE: "This model can't be regenerated right now.",
  NOT_READY: 'This model is still being worked on. Refresh the page.',
  RETRY_LIMIT: "You've used all 3 retries for these photos. Start again with different photos.",
  GLB_MISSING: "This model's file is no longer available. Try generating it again.",
  CHARGE_NOT_CONFIRMED: 'This model costs $5. Confirm to save it.',
  TOO_MANY_RUNNING: 'Too many models are being generated. Wait for one to finish.',
  DAILY_LIMIT: "You've reached today's limit of 20 AI generations. Try again tomorrow.",
}

const SHOP_ID_QUERY = `#graphql
  query ShopId {
    shop { id }
  }`

async function shopGidFor(admin) {
  const res = await admin.graphql(SHOP_ID_QUERY)
  const shopGid = (await res.json())?.data?.shop?.id
  if (!shopGid) throw new Error('shop id lookup failed')
  return shopGid
}

async function deletePhotos(refs) {
  for (const ref of refs) {
    try {
      await deleteModelGlb(ref)
    } catch (cleanupError) {
      console.error('Failed to clean up imported product photo', ref, cleanupError)
    }
  }
}

// Start (or queue) a generation from photos already imported for a product.
async function createFromImported({ shop, shopGid, imported }) {
  try {
    return await createGeneration(prisma, {
      shop,
      shopGid,
      photoRefs: imported.photoRefs,
      photoSource: 'product',
      productId: imported.productId,
      productTitle: imported.title,
      productHandle: imported.handle,
    })
  } catch (error) {
    // Only when the error says no row was created: createGeneration throws these
    // before its insert. Anything else (a dropped connection after the insert)
    // may have left a row pointing at these photos, so they stay.
    if (PRE_INSERT_CODES.has(error?.code)) await deletePhotos(imported.photoRefs)
    throw error
  }
}

// Import a product's chosen photos and start (or queue) its generation.
async function generateFromProduct({ admin, shop, shopGid, productId, imageIds }) {
  const imported = await importProductPhotos({ admin, shop, productId, imageIds })
  return createFromImported({ shop, shopGid, imported })
}

function failureResult(productId, error) {
  const known = STATUS_BY_CODE[error?.code]
  if (!known) console.error('AI bulk generation item failed', productId, error)
  return {
    productId,
    code: known ? error.code : 'UNKNOWN',
    error: known ? MESSAGES[error.code] : 'Something went wrong. Try again.',
  }
}

function errorResponse(error) {
  const status = STATUS_BY_CODE[error?.code]
  if (!status) {
    console.error('AI generation request failed', error)
    return Response.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
  return Response.json({ error: MESSAGES[error.code], code: error.code }, { status })
}

function parseJson(value) {
  try {
    return JSON.parse(value ?? '')
  } catch {
    throw Object.assign(new Error('malformed JSON field'), { code: 'BAD_PHOTOS' })
  }
}

async function requestContext(request) {
  const { session, admin } = await authenticate.admin(request)
  if (!aiGenerationEnabled(session.shop)) {
    return { response: Response.json({ error: 'Not found.' }, { status: 404 }) }
  }
  const planName = await getActivePlanName(admin, session.shop)
  if (!planName) {
    return { response: Response.json({ error: 'No active subscription. Choose a plan to continue.' }, { status: 402 }) }
  }
  return { shop: session.shop, admin, planName }
}

export const loader = async ({ request }) => {
  const context = await requestContext(request)
  if (context.response) return context.response
  const rows = await listGenerations(prisma, context.shop)
  return Response.json({
    generations: rows.map(toClientGeneration),
    allowance: await getAllowance(prisma, context.shop, context.planName),
  })
}

export const action = async ({ request }) => {
  const context = await requestContext(request)
  if (context.response) return context.response
  const { shop, admin, planName } = context
  const form = await request.formData()
  const intent = form.get('intent')
  const generationId = form.get('generationId')?.toString() ?? null

  try {
    if (intent === 'presign-photos') {
      const files = parseJson(form.get('files'))
      if (!Array.isArray(files) || files.length < 3 || files.length > 4) {
        throw Object.assign(new Error('wrong photo count'), { code: 'BAD_PHOTOS' })
      }
      // Refuse before any upload URL exists, so a start the guard would refuse
      // doesn't leave orphaned photos in storage.
      await assertCanStartGeneration(prisma, shop)
      const uploads = await Promise.all(
        files.map((file) => presignPhotoUpload({ shop, contentType: file?.type, size: file?.size })),
      )
      return Response.json({ uploads })
    }

    if (intent === 'create' || intent === 'retry') {
      const generation = await createGeneration(prisma, {
        shop,
        shopGid: await shopGidFor(admin),
        photoRefs: intent === 'create' ? parseJson(form.get('photoRefs')) : null,
        retryOf: intent === 'retry' ? generationId : null,
      })
      return Response.json({ generation: toClientGeneration(generation) })
    }

    if (intent === 'product-images') {
      const product = await fetchProductImages(admin, form.get('productId')?.toString())
      return Response.json({
        product: { id: product.productId, title: product.title },
        images: product.images.map(({ id, thumbnailUrl, altText }) => ({ id, thumbnailUrl, altText })),
      })
    }

    if (intent === 'create-from-product') {
      // Same reasoning as presign-photos: refuse before anything is stored.
      await assertCanStartGeneration(prisma, shop)
      const generation = await generateFromProduct({
        admin,
        shop,
        shopGid: await shopGidFor(admin),
        productId: form.get('productId')?.toString(),
        imageIds: parseJson(form.get('imageIds')),
      })
      return Response.json({ generation: toClientGeneration(generation) })
    }

    if (intent === 'create-from-products') {
      let items
      try {
        items = JSON.parse(form.get('items')?.toString() ?? '')
      } catch {
        items = null
      }
      const ids = Array.isArray(items)
        ? items.map((item) => (typeof item?.productId === 'string' ? item.productId : null))
        : []
      const stringIds = ids.filter((id) => id !== null)
      if (
        !Array.isArray(items) ||
        items.length < 1 ||
        items.length > 5 ||
        new Set(stringIds).size !== stringIds.length
      ) {
        throw Object.assign(new Error('bad product list'), { code: 'BAD_PRODUCTS' })
      }
      await assertCanStartGeneration(prisma, shop)
      const shopGid = await shopGidFor(admin)
      // Import every product's photos in parallel (the slow CDN + storage part),
      // then create the generations one after another in request order, so each
      // row's queue/daily decision sees the previous one.
      // Only as many products as the day still allows are imported at all, so
      // an over-limit request doesn't copy photos it would only delete again.
      const remaining = await remainingToday(prisma, shop)
      const imports = await Promise.allSettled(
        items.map((item, i) => (i < remaining
          ? importProductPhotos({ admin, shop, productId: ids[i], imageIds: item?.imageIds })
          : Promise.resolve(null))),
      )
      const results = []
      let dailyLimitHit = false
      for (let i = 0; i < items.length; i++) {
        const productId = ids[i]
        const settled = imports[i]
        if (i >= remaining) {
          results.push({ productId, code: 'DAILY_LIMIT', error: MESSAGES.DAILY_LIMIT })
          continue
        }
        if (settled.status === 'rejected') {
          results.push(failureResult(productId, settled.reason))
          continue
        }
        const imported = settled.value
        if (dailyLimitHit) {
          await deletePhotos(imported.photoRefs)
          results.push({ productId, code: 'DAILY_LIMIT', error: MESSAGES.DAILY_LIMIT })
          continue
        }
        try {
          const generation = await createFromImported({ shop, shopGid, imported })
          results.push({ productId, generation: toClientGeneration(generation) })
        } catch (error) {
          if (error?.code === 'DAILY_LIMIT') dailyLimitHit = true
          results.push(failureResult(productId, error))
        }
      }
      return Response.json({ results })
    }

    if (intent === 'save') {
      const saved = await saveGeneration(prisma, {
        shop,
        generationId,
        planName,
        acceptCharge: form.get('acceptCharge') === 'true',
      })
      if (!saved.productId) return Response.json(saved)
      const mapping = await addGeneratedModelToProduct({
        prisma,
        admin,
        shop,
        planName,
        productId: saved.productId,
        productHandle: saved.productHandle,
        modelAssetId: saved.assetId,
      })
      return Response.json({ ...saved, mapping })
    }

    if (intent === 'discard') {
      await discardGeneration(prisma, shop, generationId)
      return Response.json({ discarded: true })
    }

    return Response.json({ error: 'Unknown action.' }, { status: 400 })
  } catch (error) {
    return errorResponse(error)
  }
}
