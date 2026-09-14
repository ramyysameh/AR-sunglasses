import prisma from '../db.server'
import { readModelGlb } from '../storage.server'
import { composeFitPreview } from '../fitPreview.server'

export const loader = async ({ params, request }) => {
  const asset = await prisma.modelAsset.findUnique({ where: { id: params.assetId } })
  if (!asset) return new Response('not found', { status: 404 })
  const frames = await readModelGlb(asset.storageRef)
  if (!frames) return new Response('not found', { status: 404 })
  // mock-head.glb is served statically at /mock-head.glb -- fetch it from
  // this app's own origin rather than the filesystem. Vercel's preset emits
  // public/ to static output, not into the serverless function, and .glb is
  // not in Vite's default assetsInclude, so a filesystem read only works
  // locally by accident of build layout.
  const headRes = await fetch(new URL('/mock-head.glb', request.url))
  const head = await headRes.arrayBuffer()
  const glb = await composeFitPreview(head, frames, asset.fitMetadata)
  return new Response(glb, {
    headers: {
      'Content-Type': 'model/gltf-binary',
      // Immutable: the composition is a pure function of an asset that never
      // changes in place -- a re-upload creates a new id.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}
