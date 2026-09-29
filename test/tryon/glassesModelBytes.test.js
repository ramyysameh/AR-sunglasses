import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { GlassesModelLoader } from '../../src/models/GlassesModelLoader.js'

function loaderWithStubbedGltf() {
  const loader = new GlassesModelLoader()
  loader.loader = {
    parseAsync: vi.fn(async () => ({ scene: new THREE.Group() })),
    loadAsync: vi.fn(async () => ({ scene: new THREE.Group() })),
  }
  return loader
}

describe('GlassesModelLoader with already-downloaded bytes', () => {
  it('parses bytes downloaded ahead of time instead of requesting the model again', async () => {
    const loader = loaderWithStubbedGltf()
    const bytes = new ArrayBuffer(8)

    await loader.load('/models/abc.glb', undefined, { bytes: Promise.resolve(bytes) })

    expect(loader.loader.parseAsync).toHaveBeenCalledWith(bytes, '/models/')
    expect(loader.loader.loadAsync).not.toHaveBeenCalled()
  })

  it('falls back to its own request when the early download failed', async () => {
    const loader = loaderWithStubbedGltf()

    await loader.load('/models/abc.glb', undefined, { bytes: Promise.resolve(null) })

    expect(loader.loader.loadAsync).toHaveBeenCalledWith('/models/abc.glb')
    expect(loader.loader.parseAsync).not.toHaveBeenCalled()
  })

  it('still requests the model itself when given no bytes', async () => {
    const loader = loaderWithStubbedGltf()

    await loader.load('/models/abc.glb')

    expect(loader.loader.loadAsync).toHaveBeenCalledWith('/models/abc.glb')
  })
})
