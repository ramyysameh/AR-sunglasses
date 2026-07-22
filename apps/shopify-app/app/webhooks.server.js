import { deleteModelGlb } from './storage.server.js'

/**
 * Erases every trace of a shop: S3 objects first, then database rows.
 *
 * ORDER IS LOAD-BEARING. `ModelAsset.storageRef` is the only record of which
 * S3 objects belong to a shop. Deleting rows first and then failing on storage
 * would permanently lose that index, orphaning the objects in the bucket with
 * no way to find them again. Deleting storage first inverts the failure into a
 * safe one: the error propagates, the route returns 500, Shopify retries, and
 * because no row was touched the retry recomputes an identical list. S3 delete
 * on an absent key and Prisma deleteMany on an empty match are both no-ops, so
 * repeated delivery is clean.
 *
 * Database order is forced by the ProductMapping -> ModelAsset foreign key.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} shop myshopify domain, from an HMAC-verified payload
 */
export async function purgeShopData(prisma, shop) {
  // D7. This function is reused outside the HMAC-verified webhook path
  // (support tooling, manual redaction), where `shop` carries no guarantee.
  // Prisma drops undefined filter values rather than matching nothing, so
  // deleteMany({ where: { shop: undefined } }) silently becomes
  // deleteMany({}) and deletes EVERY TENANT'S ROWS. Verified against Neon on
  // Prisma 6.19.3. Guard before any client call.
  if (!shop || typeof shop !== 'string') {
    throw new TypeError(
      `purgeShopData: refusing to purge with invalid shop: ${String(shop)}`,
    )
  }

  const assets = await prisma.modelAsset.findMany({
    where: { shop },
    select: { storageRef: true },
  })

  for (const { storageRef } of assets) {
    await deleteModelGlb(storageRef)
  }

  const mappings = await prisma.productMapping.deleteMany({ where: { shop } })
  const deletedAssets = await prisma.modelAsset.deleteMany({ where: { shop } })
  const sessions = await prisma.session.deleteMany({ where: { shop } })

  return {
    storageRefs: assets.length,
    mappings: mappings.count,
    assets: deletedAssets.count,
    sessions: sessions.count,
  }
}
