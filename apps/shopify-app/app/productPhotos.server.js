import { tagged } from './errors.server.js'
import { MAX_PHOTO_BYTES, newPhotoRef, savePhoto, deleteModelGlb } from './storage.server.js'

/**
 * "Create with AI" from a store product (spec addendum 2026-10-01): read the
 * product's images through the Admin API, then copy the ones the merchant ticked
 * into the same shop-scoped photo keys an upload produces, so the generation
 * pipeline doesn't know or care where the photos came from.
 */

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/
const CDN_HOST = 'cdn.shopify.com'
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const DOWNLOAD_TIMEOUT_MS = 15_000

export const PRODUCT_IMAGES_QUERY = `#graphql
  query ProductImages($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      media(first: 20) {
        nodes {
          id
          mediaContentType
          ... on MediaImage {
            image {
              url(transform: { maxWidth: 2048, maxHeight: 2048, preferredContentType: JPG })
              thumbnail: url(transform: { maxWidth: 300, maxHeight: 300 })
              altText
            }
          }
        }
      }
    }
  }`

export async function fetchProductImages(admin, productId) {
  if (typeof productId !== 'string' || !PRODUCT_GID.test(productId)) {
    throw tagged('PRODUCT_NOT_FOUND', `not a product id: ${String(productId)}`)
  }
  const res = await admin.graphql(PRODUCT_IMAGES_QUERY, { variables: { id: productId } })
  const product = (await res.json())?.data?.product
  if (!product) throw tagged('PRODUCT_NOT_FOUND', `product ${productId} not found`)
  const images = (product.media?.nodes ?? [])
    .filter((node) => node?.mediaContentType === 'IMAGE' && node.image?.url)
    .map((node) => ({
      id: node.id,
      url: node.image.url,
      thumbnailUrl: node.image.thumbnail ?? node.image.url,
      altText: node.image.altText ?? null,
    }))
  return { productId: product.id, title: product.title, handle: product.handle, images }
}

function isCdnUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === CDN_HOST
  } catch {
    return false
  }
}

async function download(url, fetchImpl) {
  if (!isCdnUrl(url)) throw tagged('BAD_PHOTO', `product image is not on ${CDN_HOST}`)
  let res
  try {
    // redirect: 'error' -- a redirect could leave the CDN before the host check
    // below ever sees it, so a redirecting response is refused outright.
    res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  } catch (error) {
    throw tagged('BAD_PHOTO', `product image download failed: ${error?.message}`)
  }
  // Belt and braces: redirects are refused above, but the final address must still be the CDN.
  if (res.url && !isCdnUrl(res.url)) throw tagged('BAD_PHOTO', 'product image redirected off the CDN')
  if (!res.ok) throw tagged('BAD_PHOTO', `product image download failed: ${res.status}`)
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (!PHOTO_TYPES.includes(contentType)) throw tagged('BAD_PHOTO', `product image type ${contentType}`)
  if (Number(res.headers.get('content-length')) > MAX_PHOTO_BYTES) throw tagged('BAD_PHOTO', 'product image too large')
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) throw tagged('BAD_PHOTO', `product image size ${bytes.length}`)
  return { bytes, contentType }
}

export async function importProductPhotos({ admin, shop, productId, imageIds, fetchImpl = fetch }) {
  if (!Array.isArray(imageIds) || imageIds.length < 3 || imageIds.length > 4 || new Set(imageIds).size !== imageIds.length) {
    throw tagged('BAD_PHOTOS', 'choose 3 or 4 different product photos')
  }
  const product = await fetchProductImages(admin, productId)
  const byId = new Map(product.images.map((image) => [image.id, image]))
  const chosen = imageIds.map((id) => byId.get(id))
  if (chosen.some((image) => !image)) throw tagged('BAD_PHOTOS', 'a chosen photo is not on this product')

  const photoRefs = []
  try {
    for (const image of chosen) {
      const { bytes, contentType } = await download(image.url, fetchImpl)
      const ref = newPhotoRef(shop, contentType)
      await savePhoto(ref, bytes, contentType)
      photoRefs.push(ref)
    }
  } catch (error) {
    for (const ref of photoRefs) {
      try {
        await deleteModelGlb(ref)
      } catch (cleanupError) {
        console.error('product photo cleanup failed', ref, cleanupError)
      }
    }
    throw error
  }
  return { photoRefs, productId: product.productId, title: product.title, handle: product.handle }
}
