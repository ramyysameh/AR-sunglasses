import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as THREE from 'three'

const hoisted = vi.hoisted(() => ({ disposed: [], source: null }))

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal()
  class FakePMREMGenerator {
    compileEquirectangularShader() {}
    fromEquirectangular(source) {
      hoisted.source = source
      return {
        texture: { name: 'prefiltered-env' },
        dispose: () => hoisted.disposed.push('target'),
      }
    }
    dispose() {
      hoisted.disposed.push('generator')
    }
  }
  return { ...actual, PMREMGenerator: FakePMREMGenerator }
})

const { createLensEnvironment } = await import('../../src/core/lensEnvironment.js')

describe('createLensEnvironment', () => {
  beforeEach(() => {
    hoisted.disposed = []
    hoisted.source = null
  })

  it('returns the prefiltered texture', () => {
    const env = createLensEnvironment({})
    expect(env.texture.name).toBe('prefiltered-env')
  })

  it('tags the source texture linear and equirectangular', () => {
    // Required, not decorative: DataTexture defaults to NoColorSpace, and PMREM
    // expects linear. Untagged, rendered sun brightness silently decouples from
    // sunIntensity and looks exactly like an intensity-tuning problem.
    createLensEnvironment({})
    expect(hoisted.source.colorSpace).toBe(THREE.LinearSRGBColorSpace)
    expect(hoisted.source.mapping).toBe(THREE.EquirectangularReflectionMapping)
    expect(hoisted.source.type).toBe(THREE.FloatType)
  })

  it('disposes all three GPU resources, not just the env texture', () => {
    // RenderLoop builds the env map at construction, so an incomplete dispose
    // leaks once per model swap.
    const textureDispose = vi.spyOn(THREE.Texture.prototype, 'dispose')
    const env = createLensEnvironment({})
    env.dispose()
    expect(textureDispose).toHaveBeenCalled()
    expect(hoisted.disposed).toContain('target')
    expect(hoisted.disposed).toContain('generator')
    textureDispose.mockRestore()
  })
})
