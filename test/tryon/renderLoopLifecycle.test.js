import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { RenderLoop } from '../../src/core/RenderLoop.js'

describe('RenderLoop model lifecycle', () => {
  it('clears both splay latch keys on a model swap but keeps the measured head', () => {
    const loop = Object.create(RenderLoop.prototype)
    loop.scene = new THREE.Scene()
    loop.glassesRoot = new THREE.Object3D()
    loop.scene.add(loop.glassesRoot)
    loop._headWidthMean = 0.081
    loop._headWidthCount = 90
    loop._splayForWidth = 0.081
    loop._splayForScale = 1.2
    loop.probeEnabled = false

    const next = new THREE.Object3D()
    loop.setGlassesRoot(next)

    expect(loop.glassesRoot).toBe(next)
    expect(loop.scene.children).toContain(next)
    expect(loop._splayForWidth).toBeNull()
    expect(loop._splayForScale).toBeNull()
    expect(loop._headWidthMean).toBe(0.081)
    expect(loop._headWidthCount).toBe(90)
    expect(loop.filtersNeedReset).toBe(true)
  })

  it('clears head measurements after tracking is reset', () => {
    const loop = Object.create(RenderLoop.prototype)
    loop._headWidthMean = 0.081
    loop._headWidthCount = 90
    loop._splayForWidth = 0.081
    loop._splayForScale = 1
    loop._resetTrackingState()
    expect(loop._headWidthMean).toBeNull()
    expect(loop._headWidthCount).toBe(0)
    expect(loop._splayForWidth).toBeNull()
    expect(loop._splayForScale).toBeNull()
  })
})
