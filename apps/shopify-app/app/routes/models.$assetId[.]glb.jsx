import db from '../db.server'
import { readModelGlb } from '../storage.server'

// Public: stream the stored normalized GLB for an asset. Permissive CORS so the
// cross-origin iframe engine can fetch it. assetId is an unguessable UUID.
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
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
