import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  ContactShadow,
  isLensMesh,
  keyLightDirection,
  patchShadowShader,
  resolveContactShadowConfig,
} from '../../src/core/contactShadow.js'

function fakeRenderer() {
  return { shadowMap: { enabled: false, type: null } }
}

function faceGeometry() {
  // Two triangles of "face" followed by one of "shell", mirroring the occluder's
  // index layout (face tessellation first, shell after SHELL_INDEX_START).
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 0, -0.5, 0.05, 0, -0.5, 0, 0.05, -0.5, 0.05, 0.05, -0.5, 0, 0, -0.6,
  ]), 3))
  g.setIndex([0, 1, 2, 1, 3, 2, 0, 4, 1])
  return g
}

function glasses() {
  const root = new THREE.Group()
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.05, 0.02), new THREE.MeshStandardMaterial({ name: 'shinyBlack' }))
  const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.04), new THREE.MeshStandardMaterial({ name: 'Smoke_Lens' }))
  root.add(frame, lens)
  root.position.set(0, 0, -0.5)
  root.updateMatrixWorld(true)
  return { root, frame, lens }
}

function build(search = '') {
  const scene = new THREE.Scene()
  const renderer = fakeRenderer()
  const geometry = faceGeometry()
  const shadow = new ContactShadow({
    scene,
    renderer,
    faceGeometry: geometry,
    faceIndexCount: 6,
    config: resolveContactShadowConfig(search),
  })
  return { scene, renderer, geometry, shadow }
}

describe('resolveContactShadowConfig', () => {
  it('is on by default with soft, low-resolution settings', () => {
    const c = resolveContactShadowConfig('')
    expect(c.enabled).toBe(true)
    expect(c.opacity).toBeCloseTo(0.24)
    expect(c.elevationDeg).toBeCloseTo(20)
    expect(c.mapSize).toBe(256)
    expect(c.softness).toBe(4)
  })

  it('turns off with ?shadow=0, and under the occlusion probe', () => {
    expect(resolveContactShadowConfig('?shadow=0').enabled).toBe(false)
    expect(resolveContactShadowConfig('?probe=1').enabled).toBe(false)
  })

  it('snaps the map size to a supported power of two', () => {
    expect(resolveContactShadowConfig('?shadowmap=300').mapSize).toBe(256)
    expect(resolveContactShadowConfig('?shadowmap=900').mapSize).toBe(1024)
  })

  it('rejects out-of-range overrides', () => {
    const c = resolveContactShadowConfig('?shadowopacity=3&shadowel=95')
    expect(c.opacity).toBeCloseTo(0.24)
    expect(c.elevationDeg).toBeCloseTo(20)
  })
})

describe('keyLightDirection', () => {
  it('points up and toward the camera, unit length', () => {
    const d = keyLightDirection(38, 0)
    expect(d.y).toBeGreaterThan(0)
    expect(d.z).toBeGreaterThan(0)
    expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1)
  })
})

describe('isLensMesh', () => {
  it('matches lenses by material or mesh name, and nothing else', () => {
    const { frame, lens } = glasses()
    expect(isLensMesh(lens)).toBe(true)
    expect(isLensMesh(frame)).toBe(false)
  })
})

describe('ContactShadow', () => {
  it('enables shadow mapping with a zero-intensity, always-casting light', () => {
    const { renderer, shadow } = build()
    expect(renderer.shadowMap.enabled).toBe(true)
    expect(renderer.shadowMap.type).toBe(THREE.PCFShadowMap)
    // Zero intensity: it owns a shadow camera, it must not light the frame.
    expect(shadow.light.intensity).toBe(0)
    expect(shadow.light.castShadow).toBe(true)
  })

  it('receives on the face only, sharing the occluder position buffer', () => {
    const { geometry, shadow } = build()
    expect(shadow.geometry.getAttribute('position')).toBe(geometry.getAttribute('position'))
    expect(shadow.geometry.getIndex().count).toBe(6)
  })

  it('casts from the frame but not the lenses', () => {
    const { shadow } = build()
    const { root, frame, lens } = glasses()
    shadow.setCasters(root)
    expect(frame.castShadow).toBe(true)
    expect(lens.castShadow).toBe(false)
  })

  it('shows only while the frame is visible, and aims the light at it', () => {
    const { shadow } = build()
    const { root } = glasses()
    shadow.setCasters(root)

    shadow.update(true)
    expect(shadow.visible).toBe(true)
    expect(shadow.light.target.position.z).toBeCloseTo(-0.5)
    expect(shadow.light.position.y).toBeGreaterThan(shadow.light.target.position.y)
    expect(shadow.light.shadow.camera.right).toBeGreaterThan(0.07)
    expect(shadow.geometry.getAttribute('normal')).toBeDefined()

    root.visible = false
    shadow.update(true)
    expect(shadow.visible).toBe(false)

    root.visible = true
    shadow.update(false)
    expect(shadow.visible).toBe(false)
    // Hiding the receiver must never flip the light: that recompiles shaders.
    expect(shadow.light.castShadow).toBe(true)
  })

  it('stays hidden when disabled by config', () => {
    const { shadow } = build('?shadow=0')
    const { root } = glasses()
    shadow.setCasters(root)
    shadow.update(true)
    expect(shadow.visible).toBe(false)
  })
})

describe('patchShadowShader', () => {
  it("injects the grazing-angle fade into three's own shadow shader", () => {
    const shader = {
      vertexShader: THREE.ShaderLib.shadow.vertexShader,
      fragmentShader: THREE.ShaderLib.shadow.fragmentShader,
    }
    patchShadowShader(shader)
    // Every anchor must still exist in three's source, or the patch silently
    // becomes a no-op after an upgrade and the off-face shadow comes back.
    expect(shader.vertexShader).toContain('vShadowFacing = abs(')
    expect(shader.fragmentShader).toContain('gl_FragColor.a *= smoothstep(')
    expect(shader.fragmentShader.match(/varying float vShadowFacing/g)).toHaveLength(1)
  })
})
