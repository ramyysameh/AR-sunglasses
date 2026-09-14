import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFile } from 'node:fs/promises'

// Real bytes, not stubs: the regression this covers (a bare ArrayBuffer from
// headRes.arrayBuffer() failing gltf-transform's assertView) only shows up
// when composeFitPreview actually runs against real GLBs, so fitPreview.server
// is deliberately left unmocked here.
const head = await readFile(new URL('../public/mock-head.glb', import.meta.url))
const frames = await readFile(new URL('../test-fixtures/tagged-sample.glb', import.meta.url))

const fitMetadata = {
  version: 'eyewear-v1',
  bridgeAnchor: { x: 0, y: 0, z: 0.005297675263136625 },
  leftHinge: { x: -0.0725, y: -0.007025, z: 0.000036 },
  rightHinge: { x: 0.0725, y: -0.007025, z: 0.000036 },
  frameWidthMeters: 0.1450000107288361,
  frontFramePlaneZ: 0.005297675263136625,
}

vi.mock('../app/db.server.js', () => ({
  default: {
    modelAsset: {
      findUnique: async () => ({ id: 'abc', storageRef: 'abc.glb', fitMetadata }),
    },
  },
}))
vi.mock('../app/storage.server.js', () => ({
  readModelGlb: async () => frames,
}))

const { loader } = await import('../app/routes/models.$assetId.fit-preview[.]glb.jsx')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GET /models/:assetId/fit-preview.glb', () => {
  it('serves a merged GLB when the mock-head fetch succeeds', async () => {
    // Regression coverage: the prior code passed headRes.arrayBuffer()'s raw
    // ArrayBuffer straight into composeFitPreview, which throws inside
    // gltf-transform's assertView because ArrayBuffer.isView() is false for a
    // plain ArrayBuffer. The route's own catch then swallowed that throw as a
    // 404, so this exact path -- a real fetch, not a mock of composeFitPreview
    // -- is what has to pass for the fix to be proven.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(head, { status: 200 })))

    const res = await loader({
      params: { assetId: 'abc' },
      request: new Request('https://shop.example/models/abc/fit-preview.glb'),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('model/gltf-binary')
    expect(res.headers.get('Cache-Control')).toBe(
      'public, max-age=31536000, s-maxage=31536000, immutable',
    )
    // Uint8Array + TextDecoder rather than Buffer: the ESLint config declares
    // no node env, so Buffer trips no-undef.
    const body = new Uint8Array(await res.arrayBuffer())
    expect(new TextDecoder().decode(body.slice(0, 4))).toBe('glTF')
  })

  it('404s instead of feeding an error body to the GLB parser when the head fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))

    const res = await loader({
      params: { assetId: 'abc' },
      request: new Request('https://shop.example/models/abc/fit-preview.glb'),
    })

    expect(res.status).toBe(404)
  })
})
