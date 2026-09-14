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
