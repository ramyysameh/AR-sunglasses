import prisma from '../db.server'
import { readModelGlb } from '../storage.server'
import { composeFitPreview } from '../fitPreview.server'

export const loader = async ({ params, request }) => {
  // Three distinct throw paths live in this body (missing asset bytes, a GLB
  // read failure, a merge failure). PreviewPanel has no fallback for a
  // failing model src -- it handles a null qr and a null previewUrl, but not
  // an image/model that fails to load -- so treat any failure here as "no
  // preview available" rather than surfacing a bare 500.
  try {
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
    if (!headRes.ok) {
      console.error(`mock-head.glb fetch failed with status ${headRes.status}`)
      return new Response('not found', { status: 404 })
    }
    // readBinary requires an ArrayBufferView (it calls BufferUtils.assertView,
    // which checks ArrayBuffer.isView()) -- a bare ArrayBuffer fails that
    // check, so wrap it in a Uint8Array before handing it to composeFitPreview.
    const head = new Uint8Array(await headRes.arrayBuffer())
    const glb = await composeFitPreview(head, frames, asset.fitMetadata)
    return new Response(glb, {
      headers: {
        'Content-Type': 'model/gltf-binary',
        // Immutable: the composition is a pure function of an asset that
        // never changes in place -- a re-upload creates a new id. s-maxage
        // matches the sibling models.$assetId[.]glb.jsx route: it's what
        // makes Vercel's edge cache the response, so a cold browser doesn't
        // cost a database read, an S3 fetch, and a full decode/merge/
        // re-encode of the GLB inside a serverless function every time.
        'Cache-Control': 'public, max-age=31536000, s-maxage=31536000, immutable',
      },
    })
  } catch (e) {
    console.error('fit-preview.glb loader failed', e)
    return new Response('not found', { status: 404 })
  }
}
