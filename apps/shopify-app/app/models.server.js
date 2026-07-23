import { calibrateUpload } from './calibration.server.js'
import { saveModelGlb } from './storage.server.js'
import { fetchRemoteGlb } from './remoteGlb.server.js'
import { tagged } from './errors.server.js'

// Task 5 core pipeline (HTTP-free, so it's testable without the admin UI):
// calibrate the uploaded GLB via A1, store the normalized bytes, and persist a
// ModelAsset for the shop. Returns a summary for the admin route to display.
// Throws (via calibrateUpload) when the model fails validation.
export async function saveCalibratedModel(prisma, shop, glbBytes) {
  const result = await calibrateUpload(glbBytes)
  const storageRef = `${globalThis.crypto.randomUUID()}.glb`
  await saveModelGlb(storageRef, result.normalizedGlb)
  const confidence = result.confidence?.overall ?? null
  const asset = await prisma.modelAsset.create({
    data: {
      shop,
      storageRef,
      fitMetadata: result.fitMetadata,
      confidence,
      status: result.needsManual ? 'needs_manual' : 'ready',
    },
  })
  return {
    assetId: asset.id,
    status: result.validation.status,
    source: result.fitMetadata.provenance.source,
    confidence,
    needsManual: result.needsManual,
  }
}

// Task 9: map a product to a calibrated model. Upsert on (shop, productId) so
// re-mapping a product replaces its model instead of creating a duplicate.
export async function mapProductToModel(prisma, shop, productId, modelAssetId) {
  // The asset must belong to this shop. Without this, a client-supplied
  // modelAssetId can create a cross-shop mapping -- and because the FK is
  // ON DELETE RESTRICT, that mapping makes the owning shop's redaction throw
  // on every retry, permanently blocking erasure.
  const owned = await prisma.modelAsset.findFirst({ where: { id: modelAssetId, shop } })
  if (!owned) {
    throw new Error('model asset does not belong to this shop')
  }
  return prisma.productMapping.upsert({
    where: { shop_productId: { shop, productId } },
    update: { modelAssetId },
    create: { shop, productId, modelAssetId },
  })
}

export async function listMappings(prisma, shop) {
  return prisma.productMapping.findMany({
    where: { shop },
    orderBy: { createdAt: 'desc' },
    include: { modelAsset: true },
  })
}

// Block-level GLB: calibrate a merchant-hosted GLB once and cache it, keyed by
// (shop, sourceUrl).
//
// Previously keyed by sourceUrl alone under a synthetic '__block__' shop, which
// shared one calibrated asset across every shop. That made the row invisible to
// purgeShopData: a merchant's block models survived shop/redact permanently,
// even though sourceUrl embeds their CDN store ID. Attribution is per-shop so
// redaction can find them. The cost is that two shops pasting the same URL each
// get their own calibration, which is correct and effectively never happens —
// Shopify CDN URLs embed the store id.
// Bounds S3 and database growth from the public registration endpoint. Dedupe
// by (shop, sourceUrl) already prevents re-calibrating the same file, so the
// realistic abuse requires uploading many distinct GLBs to Shopify's CDN.
export const MAX_MODELS_PER_SHOP = 50

export async function registerModelByUrl(prisma, url, shop) {
  // SECURITY-LOAD-BEARING, and it runs first for a reason.
  //
  // Beyond keeping rows attributable (so shop/redact can erase them), this
  // guard is what makes the installed-shop check below sound. Prisma DROPS
  // undefined filter values, so session.findFirst({ where: { shop: undefined } })
  // returns the first session of ANY shop — a request with no shop would find
  // "a" session and pass the gate. Never relax this or move it below the
  // session lookup.
  if (!shop || typeof shop !== 'string' || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
    throw tagged('SHOP_INVALID', `invalid shop: ${String(shop)}`)
  }

  // This endpoint is public and unauthenticated, so `shop` is caller-supplied.
  // This check proves the named shop is an installed customer. It does NOT
  // prove the caller IS that shop — shop A's storefront can still register a
  // GLB under shop B's name. The allowlist and quota bound the residual abuse.
  // Real authentication means App Proxy; see the spec's Out of scope.
  const installed = await prisma.session.findFirst({ where: { shop }, select: { id: true } })
  if (!installed) {
    throw tagged('SHOP_NOT_INSTALLED', `shop has no installed session: ${shop}`)
  }

  const existing = await prisma.modelAsset.findFirst({ where: { shop, sourceUrl: url } })
  if (existing) {
    return { modelUrl: `/models/${existing.id}.glb`, fitMetadata: existing.fitMetadata }
  }

  // After dedupe: a merchant at the limit must still resolve models they have
  // already registered.
  const owned = await prisma.modelAsset.count({ where: { shop } })
  if (owned >= MAX_MODELS_PER_SHOP) {
    throw tagged('QUOTA_EXCEEDED', `shop at model limit (${MAX_MODELS_PER_SHOP})`)
  }

  const glbBytes = await fetchRemoteGlb(url)

  const result = await calibrateUpload(glbBytes)
  const storageRef = `${globalThis.crypto.randomUUID()}.glb`
  await saveModelGlb(storageRef, result.normalizedGlb)

  const asset = await prisma.modelAsset.create({
    data: {
      shop,
      sourceUrl: url,
      storageRef,
      fitMetadata: result.fitMetadata,
      confidence: result.confidence?.overall ?? null,
      status: result.needsManual ? 'needs_manual' : 'ready',
    },
  })

  return { modelUrl: `/models/${asset.id}.glb`, fitMetadata: asset.fitMetadata }
}
