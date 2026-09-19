// Pure lookup: resolve a (shop, productId) to the try-on config the engine needs.
// Returns { modelUrl, fitMetadata } for a mapped product, or null when unmapped.
export async function getTryonConfig(prisma, shop, productId) {
  const mapping = await prisma.productMapping.findUnique({
    where: { shop_productId: { shop, productId } },
    include: { modelAsset: true },
  })
  if (!mapping) return null
  return {
    modelUrl: `/models/${mapping.modelAsset.id}.glb`,
    fitMetadata: mapping.modelAsset.fitMetadata,
  }
}

// One hour. This route is hit on every try-on open and is documented as never
// calling Shopify; a write per request would turn an edge-cacheable read into a
// database round trip on the storefront's hot path.
export const SEEN_THROTTLE_MS = 60 * 60 * 1000

/**
 * Record that the theme block rendered the try-on button on a storefront
 * product page -- proof the merchant finished setup, independent of whether
 * anyone has opened the try-on yet.
 *
 * This is the signal `lastSeenLiveAt` could never be: the button sits in a
 * closed <dialog> with a lazy iframe, so nothing is fetched until a shopper
 * clicks. A correctly installed block could therefore look "not on your theme"
 * indefinitely, which pushed merchants into following "Add to theme" again --
 * and that deep link adds another copy of the block every time.
 *
 * Same throttle and same best-effort contract as recordTryonSeen.
 * @returns {Promise<boolean>} whether it actually wrote
 */
export async function recordBlockInstalled(prisma, shop, productId, now = new Date()) {
  const mapping = await prisma.productMapping.findUnique({
    where: { shop_productId: { shop, productId } },
    select: { id: true, blockSeenAt: true },
  })
  if (!mapping) return false
  if (mapping.blockSeenAt && now.getTime() - mapping.blockSeenAt.getTime() < SEEN_THROTTLE_MS) {
    return false
  }
  await prisma.productMapping.update({
    where: { id: mapping.id },
    data: { blockSeenAt: now },
  })
  return true
}

/**
 * Record that the engine fetched config for this product -- proof the theme
 * block is installed and working. Per-mapping, not per-shop: a per-shop stamp
 * would mark every product live as soon as any one was used.
 *
 * Best-effort by contract: callers must not let a failure here fail the
 * response. Returns whether it actually wrote.
 * @returns {Promise<boolean>}
 */
export async function recordTryonSeen(prisma, shop, productId, now = new Date()) {
  const mapping = await prisma.productMapping.findUnique({
    where: { shop_productId: { shop, productId } },
    select: { id: true, lastSeenLiveAt: true },
  })
  if (!mapping) return false
  if (mapping.lastSeenLiveAt && now.getTime() - mapping.lastSeenLiveAt.getTime() < SEEN_THROTTLE_MS) {
    return false
  }
  await prisma.productMapping.update({
    where: { id: mapping.id },
    data: { lastSeenLiveAt: now },
  })
  return true
}
