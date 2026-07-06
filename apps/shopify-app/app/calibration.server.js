import { NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import { validateModel, normalizeModel, calibrate, MODELING_SPEC } from '@artryon/calibration'

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS)

// Server-side A1 integration: take a raw GLB upload, validate + normalize +
// calibrate it via @artryon/calibration, and return the fit-metadata plus the
// normalized GLB bytes to persist. Throws when the model fails validation.
export async function calibrateUpload(glbBuffer) {
  const doc = await io.readBinary(glbBuffer)
  const validation = validateModel(doc, MODELING_SPEC)
  if (validation.status === 'fail') {
    throw new Error(`model rejected: ${validation.issues.map((i) => i.message).join('; ')}`)
  }
  const { doc: normalized } = normalizeModel(doc, MODELING_SPEC)
  const calibration = calibrate(normalized, MODELING_SPEC)
  const normalizedGlb = await io.writeBinary(normalized)
  return {
    validation,
    fitMetadata: calibration.fitMetadata,
    confidence: calibration.confidence,
    needsManual: calibration.needsManual,
    normalizedGlb,
  }
}
