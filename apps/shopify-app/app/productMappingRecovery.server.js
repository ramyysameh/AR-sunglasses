import { publishMapping } from './tryonMetafield.server'

export async function deleteMappingWithRecovery({
  db,
  admin,
  shop,
  productId,
  publish = publishMapping,
}) {
  try {
    await db.productMapping.deleteMany({ where: { shop, productId } })
    return null
  } catch (error) {
    console.error('product mapping delete failed', error)
    try {
      await publish(admin, productId)
    } catch (recoveryError) {
      console.error('try-on metafield recovery publish failed', recoveryError)
    }
    return {
      error: "Try-on couldn't finish removing. Your storefront setting was restored where possible; try again.",
    }
  }
}
