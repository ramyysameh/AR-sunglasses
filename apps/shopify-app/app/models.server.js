import { calibrateUpload } from './calibration.server.js'
import { saveModelGlb } from './storage.server.js'

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
// its source URL so the same URL is shared across shops. Public route entry.
const BLOCK_SHOP = '__block__'

export async function registerModelByUrl(prisma, url) {
  const existing = await prisma.modelAsset.findFirst({ where: { sourceUrl: url } })
  if (existing) {
    return { modelUrl: `/models/${existing.id}.glb`, fitMetadata: existing.fitMetadata }
  }

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status}`)
  }
  const glbBytes = new Uint8Array(await response.arrayBuffer())

  const result = await calibrateUpload(glbBytes)
  const storageRef = `${globalThis.crypto.randomUUID()}.glb`
  await saveModelGlb(storageRef, result.normalizedGlb)

  const asset = await prisma.modelAsset.create({
    data: {
      shop: BLOCK_SHOP,
      sourceUrl: url,
      storageRef,
      fitMetadata: result.fitMetadata,
      confidence: result.confidence?.overall ?? null,
      status: result.needsManual ? 'needs_manual' : 'ready',
    },
  })

  return { modelUrl: `/models/${asset.id}.glb`, fitMetadata: asset.fitMetadata }
}
