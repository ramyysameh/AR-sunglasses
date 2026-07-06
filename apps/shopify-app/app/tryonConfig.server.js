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
