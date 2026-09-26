import prisma from './db.server'
import { mapProductToModel, markFitReviewed } from './models.server'
import { publishMapping, unpublishMapping } from './tryonMetafield.server'
import { deleteMappingWithRecovery } from './productMappingRecovery.server'
import { getActivePlanName, planLimit } from './billing.server'

export async function handleProductAction({ request, admin, shop }) {
  const activePlan = await getActivePlanName(admin, shop)
  if (!activePlan) {
    return { error: 'No active subscription. Choose a plan to continue.' }
  }
  const form = await request.formData()
  const intent = form.get('intent')

  if (intent === 'map') {
    const productId = form.get('productId')?.toString().trim()
    const productHandle = form.get('productHandle')?.toString().trim() || undefined
    const modelAssetId = form.get('modelAssetId')?.toString()
    if (!productId || !modelAssetId) {
      return { error: 'Pick a product and a model.' }
    }
    // Grandfather existing: only a genuinely NEW product counts against the cap.
    // mapProductToModel upserts on (shop, productId), so a re-map is not new.
    const existing = await prisma.productMapping.findUnique({
      where: { shop_productId: { shop, productId } },
    })
    if (!existing) {
      const limit = planLimit(activePlan)
      const count = await prisma.productMapping.count({ where: { shop } })
      if (count >= limit) {
        return { error: "You've reached your plan's product limit. Upgrade to add try-on to more products." }
      }
    }
    // Throws when the asset is not this shop's -- a stale model id from a page
    // open since another session deleted it, or a tampered form. Either way the
    // merchant gets the modal's banner, not a raw framework error page, and the
    // internal message stays in the log.
    try {
      await mapProductToModel(prisma, shop, productId, modelAssetId, productHandle)
    } catch (e) {
      console.error('mapProductToModel failed', e)
      return { error: "That model isn't available any more. Pick another one." }
    }
    // The mapping is committed; now project it onto the storefront. The block
    // renders only where this metafield exists, so a failure here means a
    // mapping visible in the admin but not on the product page.
    try {
      await publishMapping(admin, productId)
    } catch (e) {
      console.error('try-on metafield publish failed', e)
      return {
        error: "Added, but try-on couldn't be turned on for your storefront. Try again.",
        retryable: true,
        productId,
        modelAssetId,
      }
    }
    return { mapped: true }
  }

  if (intent === 'mark-fit-reviewed') {
    const reviewed = await markFitReviewed(prisma, shop, form.get('modelAssetId')?.toString())
    return reviewed ? { fitReviewed: true } : { error: 'That model no longer exists.' }
  }

  if (intent !== 'unmap') {
    return { error: 'Unknown action.' }
  }
  const productId = form.get('productId')?.toString().trim()
  if (!productId) {
    return { error: 'Missing product to remove.' }
  }
  // Unpublish first so a Shopify failure leaves the database mapping in place.
  // The row and its modal then survive revalidation and the merchant can retry.
  try {
    await unpublishMapping(admin, productId)
  } catch (e) {
    console.error('try-on metafield unpublish failed', e)
    return { error: "Try-on couldn't be removed from your storefront. Nothing was changed; try again." }
  }
  const deleteError = await deleteMappingWithRecovery({
    db: prisma,
    admin,
    shop,
    productId,
  })
  if (deleteError) return deleteError
  return { unmapped: true }
}
