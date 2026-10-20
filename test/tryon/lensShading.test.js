import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { applyLensShading, lensCoverage, resolveLensShadingConfig } from '../../src/core/lensShading.js'

describe('resolveLensShadingConfig', () => {
  it('defaults to partial Fresnel and no gradient', () => {
    expect(resolveLensShadingConfig('')).toEqual({ fresnel: 0.6, gradient: 0 })
  })

  it('takes the gradient from the SKU, and lets the URL override it', () => {
    expect(resolveLensShadingConfig('', { lensGradient: 0.5 }).gradient).toBe(0.5)
    expect(resolveLensShadingConfig('?lensgrad=0.2', { lensGradient: 0.5 }).gradient).toBe(0.2)
  })

  it('ignores out-of-range values', () => {
    const c = resolveLensShadingConfig('?lensfresnel=3&lensgrad=-1', { lensGradient: 7 })
    expect(c).toEqual({ fresnel: 0.6, gradient: 0 })
  })
})

describe('lensCoverage', () => {
  const config = { fresnel: 0.6, gradient: 0 }

  it('barely changes a lens seen straight on', () => {
    // F0 = 0.04, so face-on coverage rises by only ~2.4% of the clear part.
    const c = lensCoverage(0.18, 1, 1, config)
    expect(c).toBeGreaterThan(0.18)
    expect(c).toBeLessThan(0.21)
  })

  it('covers more at grazing angles, but never fully opaque at the default strength', () => {
    const straight = lensCoverage(0.18, 1, 1, config)
    const grazing = lensCoverage(0.18, 0.1, 1, config)
    expect(grazing).toBeGreaterThan(straight + 0.25)
    expect(lensCoverage(0.18, 0, 1, config)).toBeLessThan(0.7)
  })

  it('makes the bottom of a gradient lens lighter than the top', () => {
    const grad = { fresnel: 0, gradient: 0.6 }
    expect(lensCoverage(0.6, 1, 1, grad)).toBeCloseTo(0.6)
    expect(lensCoverage(0.6, 1, 0, grad)).toBeCloseTo(0.24)
  })
})

describe('applyLensShading', () => {
  function lensMesh() {
    const material = new THREE.MeshPhysicalMaterial({ transparent: true, opacity: 0.18 })
    return new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.04), material)
  }

  it("patches three's physical shader at anchors that still exist", () => {
    const mesh = lensMesh()
    applyLensShading(mesh.material, mesh, { fresnel: 0.6, gradient: 0.4 })
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    }
    mesh.material.onBeforeCompile(shader, null)
    expect(shader.vertexShader).toContain('vLensY = position.y;')
    expect(shader.fragmentShader).toContain('diffuseColor.a += ( 1.0 - diffuseColor.a ) * lensF * uLensFresnel;')
    // Patched before three writes gl_FragColor, or the alpha change is lost.
    expect(shader.fragmentShader.indexOf('lensF * uLensFresnel')).toBeLessThan(
      shader.fragmentShader.indexOf('#include <opaque_fragment>'),
    )
    expect(shader.uniforms.uLensGradient.value).toBe(0.4)
  })

  it("measures the gradient across the lens's own height", () => {
    const mesh = lensMesh()
    applyLensShading(mesh.material, mesh, { fresnel: 0.6, gradient: 0.4 })
    const u = mesh.material.userData.lensShading
    expect(u.uLensBottom.value).toBeCloseTo(-0.02)
    expect(u.uLensHeight.value).toBeCloseTo(0.04)
  })

  it('leaves the tint colour alone', () => {
    const mesh = lensMesh()
    mesh.material.color.setRGB(0.1, 0.3, 0.2)
    applyLensShading(mesh.material, mesh, { fresnel: 0.6, gradient: 0.4 })
    expect(mesh.material.color.toArray()).toEqual([0.1, 0.3, 0.2].map((v) => expect.closeTo(v, 6)))
  })

  it('is a no-op when both effects are off', () => {
    const mesh = lensMesh()
    const before = mesh.material.onBeforeCompile
    applyLensShading(mesh.material, mesh, { fresnel: 0, gradient: 0 })
    expect(mesh.material.onBeforeCompile).toBe(before)
  })
})
