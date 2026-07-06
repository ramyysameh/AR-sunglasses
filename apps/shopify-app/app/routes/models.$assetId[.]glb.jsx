import { readFile } from 'node:fs/promises'
import db from '../db.server'
import { resolveStoragePath } from '../storage.server'

// Public: stream the stored normalized GLB for an asset. Permissive CORS so the
// cross-origin iframe engine can fetch it. assetId is an unguessable UUID.
export const loader = async ({ params }) => {
  const asset = await db.modelAsset.findUnique({ where: { id: params.assetId } })
  if (!asset) return new Response('not found', { status: 404 })
  let bytes
  try {
    bytes = await readFile(resolveStoragePath(asset.storageRef))
  } catch {
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
