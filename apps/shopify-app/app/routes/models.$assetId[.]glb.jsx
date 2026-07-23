import db from '../db.server'
import { readModelGlb } from '../storage.server'

// Public: stream the stored normalized GLB for an asset. No CORS headers -- the
// engine is served from this app and requests it relatively, so this is
// same-origin. assetId is a genuinely unguessable UUID (ModelAsset.id is
// @default(uuid())), unlike api.tryon-config, which is keyed by guessable
// (shop, productId).
export const loader = async ({ params }) => {
  const asset = await db.modelAsset.findUnique({ where: { id: params.assetId } })
  if (!asset) return new Response('not found', { status: 404 })
  // Only a genuinely absent object 404s here. readModelGlb rethrows credential and
  // network faults rather than returning null, so a storage outage surfaces as a 500
  // instead of telling every merchant their model does not exist.
  const bytes = await readModelGlb(asset.storageRef)
  if (!bytes) {
    return new Response('model file missing', { status: 404 })
  }
  return new Response(bytes, {
    headers: {
      'Content-Type': 'model/gltf-binary',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
