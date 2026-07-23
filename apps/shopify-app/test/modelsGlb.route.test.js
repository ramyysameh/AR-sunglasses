import { describe, it, expect, vi } from 'vitest'

vi.mock('../app/db.server.js', () => ({
  default: {
    modelAsset: {
      findUnique: async () => ({ id: 'abc', storageRef: 'abc.glb' }),
    },
  },
}))
vi.mock('../app/storage.server.js', () => ({
  readModelGlb: async () => Buffer.from([1, 2, 3]),
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
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600')
  })
})
