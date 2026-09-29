import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Everything network- or GPU-bound is stubbed; what is under test is only the
// ORDER in which MediaPipeThreeProvider.init starts things.
const stubs = vi.hoisted(() => ({ trackers: [], fetchModelBytes: null, loads: [] }))

vi.mock('../../src/tracking/FaceTracker.js', () => ({
  FaceTracker: class {
    constructor() {
      this.dispose = vi.fn()
      this.init = vi.fn(() => new Promise((resolve) => { this.release = () => resolve(this) }))
      stubs.trackers.push(this)
    }
  },
}))

vi.mock('../../src/core/RenderLoop.js', () => ({
  RenderLoop: class {
    async init() { return this }
    setModelConfig() {}
    setGlassesRoot() {}
    setFaceOccluder() {}
  },
}))

vi.mock('../../src/occlusion/FaceOccluder.js', () => ({
  FaceOccluder: class { async init() { return this } },
}))

vi.mock('../../src/models/GlassesModelLoader.js', () => {
  stubs.fetchModelBytes = vi.fn(async (url) => ({ bytesFor: url }))
  return {
    fetchModelBytes: stubs.fetchModelBytes,
    GlassesModelLoader: class {
      async init() { return this }
      async load(url, key, options) {
        stubs.loads.push({ url, key, bytes: await options?.bytes })
        return {}
      }
    },
  }
})

const { MediaPipeThreeProvider } = await import('../../src/tryon/providers/MediaPipeThreeProvider.js')
const { getGlassesModelUrl, registerRuntimeGlassesConfig } = await import('../../src/config/arConfig.js')

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function providerWithCamera(camera) {
  const provider = new MediaPipeThreeProvider()
  provider._startCamera = vi.fn(() => camera.promise)
  provider._initCamera = vi.fn(() => ({}))
  return provider
}

const element = () => ({ style: {}, addEventListener: vi.fn() })
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  stubs.trackers.length = 0
  stubs.loads.length = 0
  stubs.fetchModelBytes.mockClear()
  vi.stubGlobal('window', { location: { search: '' }, addEventListener: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MediaPipeThreeProvider.init ordering', () => {
  it('downloads the face tracker and the glasses while the camera prompt is still open', async () => {
    const camera = deferred()
    const skuKey = deferred()
    const provider = providerWithCamera(camera)
    const url = getGlassesModelUrl(registerRuntimeGlassesConfig('__order_test__', { modelUrl: '/models/remote.glb' }))

    const ready = provider.init({}, { video: element(), canvas: element(), defaultSkuKey: skuKey.promise })
    await flush()

    // Camera prompt is open and the shop's config has not answered yet --
    // the tracker must already be loading.
    expect(provider._startCamera).toHaveBeenCalled()
    expect(stubs.trackers).toHaveLength(1)
    expect(stubs.trackers[0].init).toHaveBeenCalled()

    // As soon as the config names a model, its download starts -- still
    // without waiting for the camera.
    skuKey.resolve('__order_test__')
    await flush()
    expect(stubs.fetchModelBytes).toHaveBeenCalledWith(url)

    camera.resolve()
    stubs.trackers[0].release()
    await ready

    expect(stubs.loads).toEqual([{ url, key: '__order_test__', bytes: { bytesFor: url } }])
    expect(provider.currentSkuKey).toBe('__order_test__')
  })

  it('still accepts a plain SKU key', async () => {
    const camera = deferred()
    const provider = providerWithCamera(camera)

    const ready = provider.init({}, { video: element(), canvas: element(), defaultSkuKey: 'sunglasses' })
    camera.resolve()
    await flush()
    stubs.trackers[0].release()
    await ready

    expect(provider.currentSkuKey).toBe('sunglasses')
    expect(stubs.loads[0].url).toBe(getGlassesModelUrl('sunglasses'))
  })

  it('releases the tracker it started when the camera is refused', async () => {
    const camera = deferred()
    const provider = providerWithCamera(camera)

    const ready = provider.init({}, { video: element(), canvas: element(), defaultSkuKey: 'sunglasses' })
    const refused = new Error('Camera access was blocked')
    camera.reject(refused)
    await expect(ready).rejects.toBe(refused)

    // The tracker was mid-load when the camera failed; once it finishes it
    // must not be left holding a WebGL context nobody will ever close.
    stubs.trackers[0].release()
    await flush()
    expect(stubs.trackers[0].dispose).toHaveBeenCalled()
  })
})
