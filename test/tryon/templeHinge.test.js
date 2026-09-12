import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  MAX_SPLAY_RAD,
  SKIN_CLEARANCE_M,
  applySplay,
  buildHeadProfile,
  buildHinges,
  earLineDepth,
  headWidthAt,
  isTempleMesh,
  selectArms,
  solveSplay,
} from '../../src/models/templeHinge.js'

const X = { x: 1, y: 0, z: 0 }
const Z = { x: 0, y: 0, z: 1 }
const ORIGIN = { x: 0, y: 0, z: 0 }

function attr(points) {
  return { count: points.length, getX: (i) => points[i][0], getY: (i) => points[i][1], getZ: (i) => points[i][2] }
}

describe('buildHeadProfile / headWidthAt', () => {
  it('records the widest point per depth bin', () => {
    const p = buildHeadProfile(attr([[0.05, 0, 0], [0.09, 0, 0], [-0.07, 0, 0], [0.03, 0, 0.02]]), ORIGIN, X, Z)
    expect(p.get(0)).toBeCloseTo(0.09)
    expect(p.get(2)).toBeCloseTo(0.03)
  })

  it('returns 0 where the head was never measured, so no data means no constraint', () => {
    expect(headWidthAt(new Map([[0, 0.09]]), 1.0)).toBe(0)
  })
})

describe('earLineDepth', () => {
  it('finds the depth where the head is widest', () => {
    const p = new Map([[0, 0.05], [-4, 0.08], [-7, 0.096], [-12, 0.04]])
    expect(earLineDepth(p)).toBeCloseTo(-0.07, 6)
  })

  it('returns null for an empty profile', () => {
    expect(earLineDepth(new Map())).toBeNull()
  })
})

describe('solveSplay', () => {
  // Head 90 mm half-width at the ear line (-70 mm), narrowing front and back.
  const profile = new Map()
  for (let b = 0; b >= -7; b -= 1) profile.set(b, 0.05 + (0.09 - 0.05) * (-b / 7))
  for (let b = -8; b >= -16; b -= 1) profile.set(b, 0.09 - (0.09 - 0.03) * ((-b - 7) / 9))

  const hinge = { lateral: 0.083, depth: -0.01 }
  const armAt = (depths, lateral = 0.083) => depths.map((d) => ({ lateral, depth: d }))

  it('leaves an arm that already clears the head alone', () => {
    const wide = armAt([-0.02, -0.04, -0.06], 0.12)
    expect(solveSplay(wide, { lateral: 0.12, depth: -0.01 }, profile)).toBe(0)
  })

  it('opens a buried arm far enough to clear the head plus the skin gap', () => {
    const samples = armAt([-0.02, -0.04, -0.06, -0.07])
    const angle = solveSplay(samples, hinge, profile)
    expect(angle).toBeGreaterThan(0)
    expect(angle).toBeLessThanOrEqual(MAX_SPLAY_RAD)

    // every enforced sample must actually be clear at that angle
    const c = Math.cos(angle), s = Math.sin(angle)
    for (const sample of samples) {
      const dx = sample.lateral - hinge.lateral
      const dz = sample.depth - hinge.depth
      const lateral = hinge.lateral + dx * c + Math.abs(dz) * s
      const depth = hinge.depth + dx * s + dz * c
      expect(lateral).toBeGreaterThanOrEqual(headWidthAt(profile, depth) + SKIN_CLEARANCE_M - 1e-9)
    }
  })

  it('ignores the hook behind the ear line, which belongs inside the head', () => {
    // A tip tucked well in at -0.13 would demand a huge angle if enforced.
    const withHook = [...armAt([-0.02, -0.04]), { lateral: 0.03, depth: -0.13 }]
    const withoutHook = armAt([-0.02, -0.04])
    expect(solveSplay(withHook, hinge, profile)).toBeCloseTo(solveSplay(withoutHook, hinge, profile), 6)
  })

  it('caps rather than opening the arm arbitrarily far', () => {
    // A head far wider than any angle can clear: the cap is a guard against a
    // bad measurement, not a target to chase.
    const huge = new Map()
    for (let b = 0; b >= -16; b -= 1) huge.set(b, 0.5)
    expect(solveSplay(armAt([-0.02, -0.05]), hinge, huge)).toBe(MAX_SPLAY_RAD)
  })

  it('does nothing when the head was never measured', () => {
    expect(solveSplay(armAt([-0.02]), hinge, new Map())).toBe(0)
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
