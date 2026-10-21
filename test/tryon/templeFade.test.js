import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { applyTempleFade } from '../../src/models/GlassesModelLoader.js'
import { applyLensShading } from '../../src/core/lensShading.js'

function compile(material) {
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  }
  material.onBeforeCompile(shader, null)
  return shader
}

const count = (src, s) => src.split(s).length - 1

describe('applyTempleFade', () => {
  it('keeps the lens shading patch applied before it', () => {
    const material = new THREE.MeshPhysicalMaterial({ transparent: true, opacity: 0.18 })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.04), material)
    applyLensShading(material, mesh, { fresnel: 0.6, gradient: 0.4 })
    applyTempleFade(material, { start: -0.08, end: -0.12 })

    const shader = compile(material)
    expect(shader.fragmentShader).toContain('lensF * uLensFresnel')
    expect(shader.fragmentShader).toContain('gl_FragColor.a *= templeFade;')
    expect(shader.uniforms.uLensGradient.value).toBe(0.4)
    expect(shader.uniforms.uTempleFadeStart.value).toBe(-0.08)
    const key = material.customProgramCacheKey()
    expect(key).toContain('|lensShading')
    expect(key).toContain('|templeFade')
  })

  // Frame and temples (and Lens_L/Lens_R) share materials, and the loader
  // patches per mesh.
  it('injects its declarations once when meshes share the material', () => {
    const material = new THREE.MeshPhysicalMaterial()
    applyTempleFade(material, { start: -0.08, end: -0.12 })
    applyTempleFade(material, { start: -0.05, end: -0.1 })

    const shader = compile(material)
    expect(count(shader.vertexShader, 'varying float vTempleZ;')).toBe(1)
    expect(count(shader.fragmentShader, 'varying float vTempleZ;')).toBe(1)
    expect(count(shader.fragmentShader, 'uniform float uTempleFadeStart;')).toBe(1)
    expect(count(shader.fragmentShader, 'gl_FragColor.a *= templeFade;')).toBe(1)
    expect(count(material.customProgramCacheKey(), '|templeFade')).toBe(1)
    // The latest call's values win.
    expect(shader.uniforms.uTempleFadeStart.value).toBe(-0.05)
    expect(shader.uniforms.uTempleFadeEnd.value).toBe(-0.1)
  })
})
