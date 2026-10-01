import { authenticate } from '../shopify.server'
import prisma from '../db.server'
import { getActivePlanName } from '../billing.server'
import { presignPhotoUpload, deleteModelGlb } from '../storage.server'
import {
  aiGenerationEnabled,
  assertCanStartGeneration,
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
  BAD_PHOTO: "One of the photos couldn't be used. Use JPG, PNG or WebP photos of 10 MB or less, or choose different product photos.",
  NOT_FOUND: 'That model is no longer available. Refresh the page.',
  PRODUCT_NOT_FOUND: 'That product is no longer available. Pick another one.',
  NOT_RETRYABLE: "This model can't be regenerated right now.",
  NOT_READY: 'This model is still being worked on. Refresh the page.',
  RETRY_LIMIT: "You've used all 3 retries for these photos. Upload a new set to try again.",
  GLB_MISSING: "This model's file is no longer available. Try generating it again.",
  CHARGE_NOT_CONFIRMED: 'This model costs $5. Confirm to save it.',
  TOO_MANY_RUNNING: 'Two models are already being generated. Wait for one to finish.',
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
      const shopGid = await shopGidFor(admin)
      const imported = await importProductPhotos({
        admin,
        shop,
        productId: form.get('productId')?.toString(),
        imageIds: parseJson(form.get('imageIds')),
      })
      let generation
      try {
        generation = await createGeneration(prisma, {
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
        if (!PRE_INSERT_CODES.has(error?.code)) throw error
        for (const ref of imported.photoRefs) {
          try {
            await deleteModelGlb(ref)
          } catch (cleanupError) {
            console.error('Failed to clean up imported product photo', ref, cleanupError)
          }
        }
        throw error
      }
      return Response.json({ generation: toClientGeneration(generation) })
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
