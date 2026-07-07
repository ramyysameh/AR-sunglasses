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
