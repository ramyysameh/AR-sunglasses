import { describe, it, expect, vi } from 'vitest'

vi.mock('../app/db.server.js', () => ({
  default: {
    modelAsset: {
      findUnique: async () => ({ id: 'abc', storageRef: 'abc.glb' }),
    },
  },
}))
vi.mock('../app/storage.server.js', () => ({
  // Uint8Array rather than Buffer: the ESLint config declares no node env, so
  // Buffer trips no-undef. Response accepts either.
  readModelGlb: async () => new Uint8Array([1, 2, 3]),
}))

const { loader } = await import('../app/routes/models.$assetId[.]glb.jsx')

describe('GET /models/:assetId.glb', () => {
  it('serves the GLB with no CORS header but keeps caching', async () => {
    // ACAO was only ever set on the 200 path, so this must hit success --
    // a 404-path test would pass without the change and prove nothing.
    const res = await loader({ params: { assetId: 'abc' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(res.headers.get('Content-Type')).toBe('model/gltf-binary')
    // immutable is safe here and ONLY here among model routes: assetId is a
    // ModelAsset.id, @default(uuid()) and unguessable, and a re-upload gets a
    // new id -- so this url's bytes can never change. s-maxage as well as
    // max-age because Vercel's edge keys function-response caching off
    // s-maxage; with max-age alone every cold browser would still run the
    // loader, costing a findUnique plus a storage fetch.
    expect(res.headers.get('Cache-Control')).toBe(
      'public, max-age=31536000, s-maxage=31536000, immutable',
    )
  })
})
