import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  TEMPLE_OPEN_RAD,
  applySplay,
  buildHinges,
  isTempleMesh,
  selectArms,
} from '../../src/models/templeHinge.js'

const X = { x: 1, y: 0, z: 0 }
const Z = { x: 0, y: 0, z: 1 }
const ORIGIN = { x: 0, y: 0, z: 0 }

function attr(points) {
  return { count: points.length, getX: (i) => points[i][0], getY: (i) => points[i][1], getZ: (i) => points[i][2] }
}

describe('TEMPLE_OPEN_RAD', () => {
  it('sits inside the window all three models passed', () => {
    // Swept per model against the head-frame end metric; the passing ranges were
    // GRIPZ 3-8, WILLOW 3-8, LARSSON 0-5, intersecting at 3-5 degrees. The
    // bounds are what the constant means, so they are asserted rather than left
    // to the comment.
    const degrees = (TEMPLE_OPEN_RAD * 180) / Math.PI
    expect(degrees).toBeGreaterThanOrEqual(3)
    expect(degrees).toBeLessThanOrEqual(5)
  })

  it('is nowhere near the angle the lateral solve used to ask for', () => {
    // The solve this replaced saturated at 0.25 rad (14.32 deg) on every model,
    // which scored 0/8 on all three once the metric stopped paying for
    // stand-off. Guarding the order of magnitude, not the exact value.
    expect(TEMPLE_OPEN_RAD).toBeLessThan(0.25 / 2)
  })
})

/** Frame with two arms, lenses, a full-width front and nose pads. */
function makeFrame(armName = 'Temple') {
  const root = new THREE.Group()
  const add = (name, pts) => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pts), 3))
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial())
    m.name = name
    root.add(m)
    return m
  }
  add('Front', [-0.07, 0, 0.01, 0.07, 0, 0.01, 0, 0.02, 0.0])
  add('Lens_L', [-0.065, -0.02, 0.008, -0.011, -0.02, 0.008, -0.04, 0.01, 0.005])
  add('NosePad_L', [-0.006, -0.02, -0.004, -0.009, -0.03, -0.008, -0.005, -0.025, -0.006])
  for (const side of [-1, 1]) {
    const pts = []
    for (let i = 0; i <= 10; i += 1) pts.push(side * 0.069, 0, -0.013 * i)
    add(`${armName}_${side < 0 ? 'L' : 'R'}`, pts)
  }
  root.updateWorldMatrix(true, true)
  return root
}

describe('buildHinges', () => {
  it('creates one pivot per side, placed at that arm\'s hinge', () => {
    const root = makeFrame()
    const hinges = buildHinges(root)
    expect(hinges).toHaveLength(2)
    for (const h of hinges) {
      expect(h.hingeLocal.z).toBeCloseTo(0, 6)                 // frontmost arm point
      expect(Math.sign(h.hingeLocal.x)).toBe(h.side)
      expect(Math.abs(h.hingeLocal.x)).toBeCloseTo(0.069, 6)
    }
  })

  it('never grabs the lenses, the front or the nose pads', () => {
    const names = buildHinges(makeFrame())
      .flatMap((h) => h.meshes.map((m) => m.name)).sort()
    expect(names).toEqual(['Temple_L', 'Temple_R'])
  })

  it('finds arms the name regex misses', () => {
    const names = buildHinges(makeFrame('Branche'))
      .flatMap((h) => h.meshes.map((m) => m.name)).sort()
    expect(names).toEqual(['Branche_L', 'Branche_R'])
  })

  it('grouping alone moves nothing', () => {
    const root = makeFrame()
    const arm = root.children.find((c) => c.name === 'Temple_R')
    const before = new THREE.Vector3().fromBufferAttribute(arm.geometry.attributes.position, 5).applyMatrix4(arm.matrixWorld)
    buildHinges(root)
    root.updateMatrixWorld(true)
    const after = new THREE.Vector3().fromBufferAttribute(arm.geometry.attributes.position, 5).applyMatrix4(arm.matrixWorld)
    expect(after.distanceTo(before)).toBeLessThan(1e-9)
  })
})

describe('applySplay', () => {
  it('swings both arms outward, not both the same way', () => {
    const root = makeFrame()
    const hinges = buildHinges(root)
    const tipOf = (side) => {
      const h = hinges.find((x) => x.side === side)
      const m = h.meshes[0]
      const p = m.geometry.attributes.position
      return new THREE.Vector3().fromBufferAttribute(p, p.count - 1).applyMatrix4(m.matrixWorld)
    }
    applySplay(hinges, 0)
    root.updateMatrixWorld(true)
    const l0 = tipOf(-1).x, r0 = tipOf(1).x
    applySplay(hinges, 0.15)
    root.updateMatrixWorld(true)
    expect(tipOf(-1).x).toBeLessThan(l0)      // left tip further left
    expect(tipOf(1).x).toBeGreaterThan(r0)    // right tip further right
  })

  it('leaves the merchant\'s vertex data untouched -- this is the whole point', () => {
    const root = makeFrame()
    const arm = root.children.find((c) => c.name === 'Temple_R')
    const original = Float32Array.from(arm.geometry.attributes.position.array)
    const hinges = buildHinges(root)
    applySplay(hinges, 0.2)
    root.updateMatrixWorld(true)
    expect(Array.from(arm.geometry.attributes.position.array)).toEqual(Array.from(original))
  })

  it('keeps the hinge end put while the tip moves', () => {
    const root = makeFrame()
    const hinges = buildHinges(root)
    const arm = hinges.find((h) => h.side === 1).meshes[0]
    const p = arm.geometry.attributes.position
    const at = (i) => new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(arm.matrixWorld)
    root.updateMatrixWorld(true)
    const hinge0 = at(0), tip0 = at(p.count - 1)
    applySplay(hinges, 0.15)
    root.updateMatrixWorld(true)
    expect(at(0).distanceTo(hinge0)).toBeLessThan(1e-6)
    expect(at(p.count - 1).distanceTo(tip0)).toBeGreaterThan(0.01)
  })
})

describe('isTempleMesh / selectArms', () => {
  it('matches arms and hinges, not lenses', () => {
    expect(makeFrame().children.filter(isTempleMesh).map((m) => m.name)).toEqual(['Temple_L', 'Temple_R'])
  })

  it('returns nothing when no part reaches behind the front slab', () => {
    // sits entirely inside the front slab (frontZ = 0.0075), so it is not an arm
    expect(selectArms([{ zBack: 0.009, zFront: 0.01, minAbsX: 0.07 }], { minZ: 0, maxZ: 0.01, halfWidth: 0.07 }))
      .toEqual([])
  })
})
