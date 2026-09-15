import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { applyModelScale } from '../../src/models/GlassesModelLoader.js'

function sceneWithChildAt(x) {
  const root = new THREE.Group()
  const child = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  child.position.set(x, 0, 0)
  root.add(child)
  root.updateMatrixWorld(true)
  return root
}

describe('applyModelScale', () => {
  it('scales a large-coordinate model down to metres', () => {
    const root = sceneWithChildAt(1.5)
    applyModelScale(root, 0.145 / 3)
    const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3())
    expect(size.x).toBeCloseTo(0.145 / 3, 4)
    expect(root.children[0].position.x).toBeCloseTo(1.5 * (0.145 / 3), 6)
  })

  it('leaves a metre-scale model untouched at modelScale 1', () => {
    const root = sceneWithChildAt(0.069)
    applyModelScale(root, 1)
    expect(root.children[0].position.x).toBeCloseTo(0.069, 6)
    expect(root.children[0].scale.x).toBeCloseTo(1, 6)
  })

  it('ignores a missing or non-finite modelScale', () => {
    // Rows written before the raw-passthrough change carry no modelScale: the
    // rescale was baked into their stored file instead, so scaling again here
    // would shrink them twice.
    for (const bad of [undefined, null, NaN, 'x']) {
      const root = sceneWithChildAt(0.069)
      applyModelScale(root, bad)
      expect(root.children[0].scale.x).toBeCloseTo(1, 6)
      expect(root.children[0].position.x).toBeCloseTo(0.069, 6)
    }
  })
})
