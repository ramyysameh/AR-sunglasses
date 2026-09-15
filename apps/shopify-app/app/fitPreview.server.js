import { Document, NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
// Document#merge() is a removed/throwing stub in the installed core version
// ("Use 'mergeDocuments(target, source)'..."); mergeDocuments(target, source)
// is its direct, same-signature replacement. unpartition() collapses the
// head's and frames' separate buffers into the single buffer a GLB requires
// -- writeBinary otherwise rejects a document with more than one.
import { mergeDocuments, unpartition } from '@gltf-transform/functions'

// Must match calibration.server.js's IO: that is what wrote framesGlb's
// bytes, so reading them back without the same extensions registered would
// throw on a required Khronos extension or silently drop an optional one.
const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS)

/**
 * Merge the mock head and a merchant's frames into one GLB. The frames are
 * already normalized, so they stay where they are and the head is moved to meet
 * them. This is the only preview that can
 * render inside the admin: camera access is impossible in Shopify's app iframe,
 * so the merchant checks scale and placement against a fixed head instead.
 *
 * @param {Uint8Array} headGlb decimated mock head
 * @param {Uint8Array} framesGlb the normalized, calibrated frames
 * @param {object} fitMetadata the asset's stored fit metadata
 * @returns {Promise<Uint8Array>}
 */
export async function composeFitPreview(headGlb, framesGlb, fitMetadata) {
  const headDoc = await io.readBinary(headGlb)
  const framesDoc = await io.readBinary(framesGlb)

  const merged = new Document()
  // Order matters: the head is merged FIRST, so scenes[0] is the head's scene
  // and everything merged after it belongs to the frames. The placement below
  // depends on that, so do not reorder these two calls.
  mergeDocuments(merged, headDoc)
  mergeDocuments(merged, framesDoc)

  const root = merged.getRoot()
  const scenes = root.listScenes()
  const target = scenes[0]

  // The head owns scenes[0]. Move its top-level nodes to meet the frames, which
  // are already normalized and stay at identity.
  for (const node of target.listChildren()) {
    applyHeadPlacement(node, fitMetadata)
  }

  // merge() concatenates scenes; collapse the frames' scenes into the head's so
  // a viewer shows both models together.
  for (const extra of scenes.slice(1)) {
    for (const node of extra.listChildren()) {
      extra.removeChild(node)
      target.addChild(node)
    }
    extra.dispose()
  }
  root.setDefaultScene(target)
  await merged.transform(unpartition())
  return io.writeBinary(merged)
}

// The source bust uses normalized authoring units (about 1.9 units wide), while
// uploaded frames are calibrated in metres (0.145 m wide). Scale the bust into
// the same coordinate system before placing its eye line and face plane behind
// the frames. These values are fixed to the vendored mock-head.glb geometry.
const HEAD_SCALE = 0.2
const HEAD_OFFSET = { x: 0, y: -0.076, z: -0.1 }

function applyHeadPlacement(node, fitMetadata) {
  // bridgeAnchor.z is where the frames' bridge sits; nudge the head by it so a
  // deeper or shallower frame front still rests on the nose.
  const bridgeZ = fitMetadata?.bridgeAnchor?.z
  node.setScale([HEAD_SCALE, HEAD_SCALE, HEAD_SCALE])
  node.setTranslation([
    HEAD_OFFSET.x,
    HEAD_OFFSET.y,
    HEAD_OFFSET.z + (typeof bridgeZ === 'number' ? bridgeZ : 0),
  ])
}
