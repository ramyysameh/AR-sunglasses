/**
 * Builds the lens reflection environment: a procedural sky, PMREM-prefiltered
 * so it can be used as an envMap.
 *
 * Applied to LENS materials only (see lensReflection.js). scene.environment is
 * deliberately never assigned — that would light the frame too and bring back
 * the glare removed in 2e12c0f.
 */
import * as THREE from 'three'
import { createSkyPixels } from './skyTexture.js'

const WIDTH = 128
const HEIGHT = 64

export function createLensEnvironment(renderer, options = {}) {
  const pixels = createSkyPixels({ width: WIDTH, height: HEIGHT, ...options })

  const source = new THREE.DataTexture(pixels, WIDTH, HEIGHT, THREE.RGBAFormat, THREE.FloatType)
  source.mapping = THREE.EquirectangularReflectionMapping
  // REQUIRED: DataTexture defaults to NoColorSpace and PMREM expects linear
  // radiance, which is what createSkyPixels emits.
  source.colorSpace = THREE.LinearSRGBColorSpace
  source.needsUpdate = true

  const generator = new THREE.PMREMGenerator(renderer)
  generator.compileEquirectangularShader()
  const target = generator.fromEquirectangular(source)

  return {
    texture: target.texture,
    dispose() {
      source.dispose()
      target.dispose()
      generator.dispose()
    },
  }
}
