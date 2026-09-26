import { tagged } from './errors.server.js'

/**
 * The theme block cannot query this app's database, so "this product has a
 * model" is mirrored into an app-owned product metafield that Liquid can read:
 *
 *   block.settings.product.metafields["$app:tryon"].enabled.value
 *
 * ProductMapping stays the source of truth; the metafield is a projection of it,
 * and its presence is the storefront's entire gate. A boolean (rather than the
 * asset id) is deliberate: the block only needs to know THAT a model exists --
 * which one it is gets resolved at runtime by /api/tryon-config -- so there is
 * no second copy of a value that changes on every re-map.
 *
 * Owner is the product, so the write is covered by the write_products scope the
 * app already holds. No new scope, no metafield definition: the $app reserved
 * namespace is owned by this app and readable by its own theme app extension.
 */
export const TRYON_NAMESPACE = '$app:tryon'
export const TRYON_KEY = 'enabled'

// metafieldsSet accepts at most 25 metafields per call.
const BATCH = 25

const SET_MUTATION = `#graphql
  mutation PublishTryon($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }`

const DELETE_MUTATION = `#graphql
  mutation UnpublishTryon($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      userErrors { field message }
    }
  }`

// Unmapping a product the merchant has already deleted, or one whose metafield
// is already gone, is a no-op rather than a failure -- the desired end state
// (no metafield) is what we have. Kept narrow on purpose: anything else must
// still surface, because a stale metafield leaves a button that opens to a 404.
const ALREADY_GONE = /not found|does not exist|doesn't exist|no metafield/i

async function mutate(admin, mutation, variables, field) {
  const res = await admin.graphql(mutation, { variables })
  const body = await res.json()
  return [...(body?.data?.[field]?.userErrors ?? []), ...(body?.errors ?? [])]
}

function chunk(items) {
  const out = []
  for (let i = 0; i < items.length; i += BATCH) out.push(items.slice(i, i + BATCH))
  return out
}

function setInput(productId) {
  return {
    ownerId: productId,
    namespace: TRYON_NAMESPACE,
    key: TRYON_KEY,
    type: 'boolean',
    value: 'true',
  }
}

/**
 * Make the try-on block visible on these products. Idempotent: metafieldsSet
 * overwrites, so re-publishing an already-published mapping is harmless.
 */
export async function publishMappings(admin, productIds) {
  const ids = [...new Set(productIds)].filter(Boolean)
  if (ids.length === 0) return
  const errors = []
  for (const batch of chunk(ids)) {
    errors.push(...(await mutate(admin, SET_MUTATION, { metafields: batch.map(setInput) }, 'metafieldsSet')))
  }
  if (errors.length) {
    throw tagged('METAFIELD_SET_FAILED', errors.map((e) => e.message).join('; '))
  }
}

export async function publishMapping(admin, productId) {
  return publishMappings(admin, [productId])
}

/** Hide the try-on block on this product again. */
export async function unpublishMapping(admin, productId) {
  const errors = await mutate(
    admin,
    DELETE_MUTATION,
    { metafields: [{ ownerId: productId, namespace: TRYON_NAMESPACE, key: TRYON_KEY }] },
    'metafieldsDelete',
  )
  const real = errors.filter((e) => !ALREADY_GONE.test(e?.message ?? ''))
  if (real.length) {
    throw tagged('METAFIELD_DELETE_FAILED', real.map((e) => e.message).join('; '))
  }
}

/**
 * Storefront access after a subscription lapses, mirrored into an app-data
 * metafield (owner: this app's installation) that the theme block reads as
 * `app.metafields.tryon.serve_until`. Product metafields alone kept the Try on
 * button up forever on a lapsed shop, opening to a try-on that could only fail.
 *
 * A date, not a boolean: grace is a window (billing.server.js GRACE_PERIOD_DAYS)
 * and no event fires when it ends, so the block compares it with the render
 * time itself. Absent means "no limit", so installs that predate this, comped
 * shops, and active subscriptions all keep their button.
 */
export const ACCESS_NAMESPACE = 'tryon'
export const ACCESS_KEY = 'serve_until'

const APP_INSTALLATION_QUERY = `#graphql
  query TryonAppInstallation { currentAppInstallation { id } }`

/**
 * @param {{graphql: Function}} admin
 * @param {Date|null} graceEndsAt set while lapsed; null once active again
 */
export async function syncStorefrontAccess(admin, graceEndsAt) {
  const res = await admin.graphql(APP_INSTALLATION_QUERY)
  const body = await res.json()
  const ownerId = body?.data?.currentAppInstallation?.id
  if (!ownerId) {
    throw tagged('APP_INSTALLATION_MISSING', 'no currentAppInstallation id')
  }
  const identifier = { ownerId, namespace: ACCESS_NAMESPACE, key: ACCESS_KEY }

  if (graceEndsAt) {
    const errors = await mutate(admin, SET_MUTATION, {
      metafields: [{ ...identifier, type: 'date_time', value: new Date(graceEndsAt).toISOString() }],
    }, 'metafieldsSet')
    if (errors.length) throw tagged('METAFIELD_SET_FAILED', errors.map((e) => e.message).join('; '))
    return
  }

  const errors = await mutate(admin, DELETE_MUTATION, { metafields: [identifier] }, 'metafieldsDelete')
  const real = errors.filter((e) => !ALREADY_GONE.test(e?.message ?? ''))
  if (real.length) throw tagged('METAFIELD_DELETE_FAILED', real.map((e) => e.message).join('; '))
}
