import { readFile } from 'node:fs/promises'
import prisma from '../db.server'
import { readModelGlb } from '../storage.server'
import { composeFitPreview } from '../fitPreview.server'

export const loader = async ({ params }) => {
  const asset = await prisma.modelAsset.findUnique({ where: { id: params.assetId } })
  if (!asset) return new Response('not found', { status: 404 })
  const frames = await readModelGlb(asset.storageRef)
  if (!frames) return new Response('not found', { status: 404 })
  const head = await readFile(new URL('../../public/mock-head.glb', import.meta.url))
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
