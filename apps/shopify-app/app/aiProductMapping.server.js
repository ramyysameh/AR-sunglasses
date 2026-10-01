import { planLimit } from './billing.server.js'
import { mapProductToModel } from './models.server.js'
import { publishMapping } from './tryonMetafield.server.js'

/**
 * After a product-sourced AI model is saved, put it on that product's try-on.
 * Same rules as "Add try-on" (productActions.server.js 'map'): the plan's
 * product limit applies only to a product without try-on yet, the mapping
 * upserts, and the $app:tryon metafield is published. Kept separate from
 * productActions because that file's tests are DB-backed. Never throws: the
 * save has already succeeded and must not look like a failure.
 */
export async function addGeneratedModelToProduct({ prisma, admin, shop, planName, productId, productHandle, modelAssetId }) {
  try {
    const existing = await prisma.productMapping.findUnique({ where: { shop_productId: { shop, productId } } })
    if (!existing) {
      const count = await prisma.productMapping.count({ where: { shop } })
      if (count >= planLimit(planName)) return { mapped: false, reason: 'product_limit' }
    }
    await mapProductToModel(prisma, shop, productId, modelAssetId, productHandle ?? undefined)
  } catch (error) {
    console.error('AI model auto-map failed', productId, error)
    return { mapped: false, reason: 'map_failed' }
  }
  try {
    await publishMapping(admin, productId)
  } catch (error) {
    console.error('AI model auto-map: try-on metafield publish failed', productId, error)
    return { mapped: false, reason: 'publish_failed' }
  }
  return { mapped: true }
}
