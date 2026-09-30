import db from '../db.server'
import { readModelGlb } from '../storage.server'

// Public, like models/:assetId.glb: model-viewer's fetch carries no App Bridge
// token, and the id is an unguessable UUID. Unlike saved models, a pending
// result can be discarded or replaced, so it is never cached.
export const loader = async ({ params }) => {
  const generation = await db.modelGeneration.findUnique({ where: { id: params.generationId } })
  if (!generation || !generation.glbRef || !['ready', 'saving'].includes(generation.status)) {
    return new Response('not found', { status: 404 })
  }
  const bytes = await readModelGlb(generation.glbRef)
  if (!bytes) return new Response('not found', { status: 404 })
  return new Response(bytes, {
    headers: { 'Content-Type': 'model/gltf-binary', 'Cache-Control': 'private, no-store' },
  })
}
