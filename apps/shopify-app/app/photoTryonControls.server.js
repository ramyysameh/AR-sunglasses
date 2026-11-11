import { tagged } from './errors.server.js'
import { TRYON_NAMESPACE } from './tryonMetafield.server.js'
import { LIMITS, photoTryonEnabled } from './photoTryon.server.js'

/**
 * Merchant controls for photo try-on (spec 2026-11-11): which products show the
 * "Try on with a photo" button, and how much of today's allowance is used.
 *
 * On is the default for every product in an enabled shop, with or without a 3D
 * model, so only the products switched OFF are stored. Each lives in two places
 * that must agree:
 *   - PhotoTryonOff row: the server's check, before any OpenAI cost.
 *   - product metafield $app:tryon.photo_off = true: what the storefront block
 *     reads to hide the button (Liquid cannot query this app's database).
 */

export const PHOTO_OFF_KEY = 'photo_off'
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/
const DAY_MS = 24 * 60 * 60 * 1000

// Enough for the stores this is built for; the card says so if there are more.
export const PRODUCT_LIST_LIMIT = 100

const PRODUCTS_QUERY = `#graphql
  query PhotoTryonProducts($first: Int!) {
    products(first: $first, sortKey: TITLE) {
      nodes {
        id
        title
        status
        featuredMedia { preview { image { url altText } } }
      }
      pageInfo { hasNextPage }
    }
  }`

const SET_MUTATION = `#graphql
  mutation PhotoTryonOff($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }`

const DELETE_MUTATION = `#graphql
  mutation PhotoTryonOn($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      userErrors { field message }
    }
  }`

const ALREADY_GONE = /not found|does not exist|doesn't exist|no metafield/i

export async function isProductPhotoOff(db, shop, productId) {
  const row = await db.photoTryonOff.findUnique({ where: { shop_productId: { shop, productId } } })
  return Boolean(row)
}

async function writeMetafield(admin, productId, off) {
  const res = off
    ? await admin.graphql(SET_MUTATION, {
      variables: {
        metafields: [{ ownerId: productId, namespace: TRYON_NAMESPACE, key: PHOTO_OFF_KEY, type: 'boolean', value: 'true' }],
      },
    })
    : await admin.graphql(DELETE_MUTATION, {
      variables: { metafields: [{ ownerId: productId, namespace: TRYON_NAMESPACE, key: PHOTO_OFF_KEY }] },
    })
  const body = await res.json()
  const field = off ? 'metafieldsSet' : 'metafieldsDelete'
  const errors = [...(body?.data?.[field]?.userErrors ?? []), ...(body?.errors ?? [])]
    .filter((e) => off || !ALREADY_GONE.test(e?.message ?? ''))
  if (errors.length) throw tagged('METAFIELD_FAILED', errors.map((e) => e.message).join('; '))
}

/**
 * Switch photo try-on on or off for one product. The storefront metafield is
 * written first: if it fails nothing changes, and the database (the server's
 * gate) is only updated once shoppers will actually see the new state.
 */
export async function setProductPhotoTryon({ db, admin, shop, productId, on }) {
  if (!photoTryonEnabled(shop)) throw tagged('NOT_ENABLED', 'photo try-on is not enabled for this shop')
  if (typeof productId !== 'string' || !PRODUCT_GID.test(productId)) throw tagged('BAD_PRODUCT', 'not a product id')
  await writeMetafield(admin, productId, !on)
  if (on) {
    await db.photoTryonOff.deleteMany({ where: { shop, productId } })
  } else {
    await db.photoTryonOff.upsert({
      where: { shop_productId: { shop, productId } },
      create: { shop, productId },
      update: {},
    })
  }
  return { productId, on }
}

/**
 * Everything the Workspace card shows, or null when the shop doesn't have the
 * feature (the card is not rendered at all then).
 */
export async function loadPhotoTryonPanel({ db, admin, shop, now = new Date() }) {
  if (!photoTryonEnabled(shop)) return null
  const since = new Date(now.getTime() - DAY_MS)
  const [usedToday, offRows, productsRes] = await Promise.all([
    db.photoTryon.count({ where: { shop, createdAt: { gte: since } } }),
    db.photoTryonOff.findMany({ where: { shop }, select: { productId: true } }),
    admin.graphql(PRODUCTS_QUERY, { variables: { first: PRODUCT_LIST_LIMIT } }),
  ])
  const off = new Set(offRows.map((row) => row.productId))
  const body = await productsRes.json()
  const nodes = body?.data?.products?.nodes ?? []
  const products = nodes.map((node) => ({
    id: node.id,
    title: node.title,
    status: node.status ?? null,
    imageUrl: node.featuredMedia?.preview?.image?.url ?? null,
    imageAlt: node.featuredMedia?.preview?.image?.altText ?? null,
    on: !off.has(node.id),
  }))
  return {
    usedToday,
    dailyLimit: LIMITS.perShop,
    perShopper: LIMITS.perClient,
    products,
    onCount: products.filter((p) => p.on).length,
    hasMore: Boolean(body?.data?.products?.pageInfo?.hasNextPage),
  }
}

const MESSAGES = {
  NOT_ENABLED: 'Photo try-on is not available for this store.',
  BAD_PRODUCT: 'That product could not be found. Refresh the page.',
  METAFIELD_FAILED: "Shopify didn't save the change. Try again.",
}

/** Workspace action handler for intent=photo-tryon. */
export async function handlePhotoTryonAction({ form, db, admin, shop }) {
  const productId = String(form.get('productId') ?? '')
  const on = form.get('on') === 'true'
  try {
    await setProductPhotoTryon({ db, admin, shop, productId, on })
    return { photoTryon: { productId, on } }
  } catch (error) {
    const known = Object.prototype.hasOwnProperty.call(MESSAGES, error?.code)
    if (!known) console.error('photo try-on toggle failed', error)
    return { photoTryon: { productId, error: known ? MESSAGES[error.code] : 'Something went wrong. Try again.' } }
  }
}
