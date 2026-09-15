import { NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import { validateModel, normalizeModel, calibrate, MODELING_SPEC } from '@artryon/calibration'

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS)

/**
 * Server-side A1 integration: validate a raw GLB upload, measure its anchors,
 * and return fit-metadata plus THE CALLER'S OWN BYTES to persist.
 *
 * Normalization is a measurement pass over an in-memory copy, never a rewrite of
 * what we store. bakeNodeTransforms rewrites POSITION without transforming
 * NORMAL, so a model with any rotated mesh node came out the far side with its
 * shading inverted -- measured at 102.7 deg mean normal error across 22 nodes on
 * one real merchant file, and 98.9% of normals left facing inward on another.
 *
 * Nothing downstream needed the rewritten file: three.js applies node transforms
 * itself, the recentring is redone by GlassesModelLoader from the model's own
 * bounds, and the only transform that changes real-world size now travels as
 * fitMetadata.modelScale instead of as rewritten vertices.
 *
 * Throws when the model fails validation.
 */
export async function calibrateUpload(glbBuffer) {
  const doc = await io.readBinary(glbBuffer)
  const validation = validateModel(doc, MODELING_SPEC)
  if (validation.status === 'fail') {
    throw new Error(`model rejected: ${validation.issues.map((i) => i.message).join('; ')}`)
  }
  // normalizeModel mutates `doc` in place. That is fine precisely because this
  // doc is never serialised -- it exists only to be measured.
  const { doc: measured, scale } = normalizeModel(doc, MODELING_SPEC)
  const calibration = calibrate(measured, MODELING_SPEC, { modelScale: scale })
  return {
    validation,
    fitMetadata: calibration.fitMetadata,
    confidence: calibration.confidence,
    needsManual: calibration.needsManual,
    storedGlb: glbBuffer,
  }
}
