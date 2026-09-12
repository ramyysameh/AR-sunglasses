import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  MAX_CURL_RAD,
  TEMPLE_ON_TOP_ORDER,
  MAX_SPLAY_RAD,
  TEMPLE_CURL_RAD,
  TEMPLE_CUT_RATIO,
  TEMPLE_GRAZE_HEAD_RATIO,
  applyCurl,
  applyNearArmClip,
  solveSplay,
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

describe('solveSplay', () => {
  const deg = (rad) => (rad * 180) / Math.PI
  // Head half-width AT THE TEMPLE'S HEIGHT, then where the arm sits and how far
  // back the joint is -- the engine's own measurements on the mock head.
  const HEAD = 83.3, ARM = 75.6, JOINT = 121.7

  it('rests the arm on the head rather than standing it off', () => {
    // Small now. The arm no longer has to clear the occluder -- applyNearArmClip
    // draws it in front -- so this is a skin gap, not a grazing allowance.
    expect(deg(solveSplay(HEAD, ARM, JOINT))).toBeGreaterThan(5)
    expect(deg(solveSplay(HEAD, ARM, JOINT))).toBeLessThan(14)
  })

  it('opens FURTHER on a wider head and less on a narrower one', () => {
    expect(solveSplay(HEAD * 1.1, ARM, JOINT)).toBeGreaterThan(solveSplay(HEAD, ARM, JOINT))
    expect(solveSplay(HEAD * 0.9, ARM, JOINT)).toBeLessThan(solveSplay(HEAD, ARM, JOINT))
  })

  it('tracks the frame-to-head ratio, which is how the head term was validated', () => {
    // Scaling the frame is equivalent to changing the head's relative width.
    expect(solveSplay(HEAD, ARM * 0.9, JOINT * 0.9)).toBeGreaterThan(solveSplay(HEAD, ARM, JOINT))
    expect(solveSplay(HEAD, ARM * 1.12, JOINT * 1.12)).toBeLessThan(solveSplay(HEAD, ARM, JOINT))
  })

  it('needs no splay at all once the arm already clears the head', () => {
    expect(solveSplay(HEAD, HEAD * (1 + TEMPLE_GRAZE_HEAD_RATIO) + 1, JOINT)).toBe(0)
  })

  it('caps instead of asking for an impossible angle', () => {
    expect(solveSplay(HEAD * 5, ARM, JOINT)).toBe(MAX_SPLAY_RAD)
  })

  it('returns 0 rather than NaN when the arm was never measured', () => {
    expect(solveSplay(HEAD, ARM, 0)).toBe(0)
    expect(solveSplay(0, ARM, JOINT)).toBe(0)
  })
})

describe('applyNearArmClip', () => {
  const mesh = () => ({ material: { clone() { return { ...this, clippingPlanes: null } }, clippingPlanes: null }, userData: {}, renderOrder: 0 })
  const hinges = () => [
    { side: -1, meshes: [mesh(), mesh()] },
    { side: 1, meshes: [mesh(), mesh()] },
  ]
  const PLANE = { isPlane: true }

  it('draws the near arm before the occluder and clips it, leaving the far arm alone', () => {
    const h = hinges()
    applyNearArmClip(h, -1, PLANE)
    for (const m of h[0].meshes) {
      expect(m.renderOrder).toBe(TEMPLE_ON_TOP_ORDER)
      expect(m.material.clippingPlanes).toEqual([PLANE])
    }
    for (const m of h[1].meshes) {
      expect(m.renderOrder).toBe(0)
      expect(m.material.clippingPlanes).toBeNull()
    }
  })

  it('never lifts BOTH arms, which is what showed the far one through the head', () => {
    // Applied to both, 651 of the far arm's 1529 pixels drew through the skull.
    const h = hinges()
    applyNearArmClip(h, 1, PLANE)
    const lifted = h.filter((x) => x.meshes.some((m) => m.renderOrder === TEMPLE_ON_TOP_ORDER))
    expect(lifted).toHaveLength(1)
    expect(lifted[0].side).toBe(1)
  })

  it('lifts neither arm when the head is too frontal to have a near side', () => {
    const h = hinges()
    applyNearArmClip(h, 0, PLANE)
    for (const hinge of h) for (const m of hinge.meshes) expect(m.renderOrder).toBe(0)
  })

  it('clones the material once, so clipping cannot leak into a shared one', () => {
    const h = hinges()
    const first = h[0].meshes[0].material
    applyNearArmClip(h, -1, PLANE)
    const cloned = h[0].meshes[0].material
    expect(cloned).not.toBe(first)
    applyNearArmClip(h, -1, PLANE)
    expect(h[0].meshes[0].material).toBe(cloned)
  })
})

describe('applyCurl', () => {
  const hinge = (side = 1) => ({ side, rearAngle: 0, curl: { rotation: { y: 0 } } })

  it('mirrors the sign per side', () => {
    const right = hinge(1), left = hinge(-1)
    applyCurl([right, left], 0.4)
    expect(left.curl.rotation.y).toBeCloseTo(-right.curl.rotation.y, 9)
  })

  it('clamps rather than folding an arm through the head', () => {
    const wild = hinge()
    applyCurl([wild], 5)
    expect(wild.curl.rotation.y).toBe(MAX_CURL_RAD)
    applyCurl([wild], -5)
    expect(wild.curl.rotation.y).toBe(0)
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
    // A multiple of three, so every point belongs to a triangle and the split
    // has nothing to drop.
    for (let i = 0; i < 12; i += 1) pts.push(side * 0.069, 0, -0.013 * i)
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
      .flatMap((h) => h.meshes.map((m) => m.name.replace(/__(front|rear)$/, ''))).sort()
    expect([...new Set(names)]).toEqual(['Temple_L', 'Temple_R'])
  })

  it('finds arms the name regex misses', () => {
    const names = buildHinges(makeFrame('Branche'))
      .flatMap((h) => h.meshes.map((m) => m.name.replace(/__(front|rear)$/, ''))).sort()
    expect([...new Set(names)]).toEqual(['Branche_L', 'Branche_R'])
  })

  it('cuts each arm in two and hangs the rear piece on its own pivot', () => {
    const hinges = buildHinges(makeFrame())
    for (const h of hinges) {
      expect(h.frontMeshes).toHaveLength(1)
      expect(h.rearMeshes).toHaveLength(1)
      expect(h.rearMeshes[0].parent).toBe(h.curl)
      expect(h.curl.parent).toBe(h.group)
      // the joint sits between hinge and tip, at the documented fraction
      expect(h.cutZ).toBeLessThan(h.hingeLocal.z)
      expect(h.cutZ).toBeGreaterThan(-0.13)
    }
  })

  it('grouping and cutting alone move nothing', () => {
    // Every point of the original arm must still be exactly where it was once
    // the arm has been split and reparented, before any angle is applied.
    const root = makeFrame()
    const arm = root.children.find((c) => c.name === 'Temple_R')
    const p = arm.geometry.attributes.position
    const before = []
    for (let i = 0; i < p.count; i += 1) {
      before.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(arm.matrixWorld))
    }
    const hinges = buildHinges(root)
    root.updateMatrixWorld(true)

    const after = []
    for (const mesh of hinges.find((h) => h.side === 1).meshes) {
      const q = mesh.geometry.attributes.position
      for (let i = 0; i < q.count; i += 1) {
        after.push(new THREE.Vector3().fromBufferAttribute(q, i).applyMatrix4(mesh.matrixWorld))
      }
    }
    for (const point of before) {
      expect(Math.min(...after.map((a) => a.distanceTo(point)))).toBeLessThan(1e-6)
    }
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
    const h = hinges.find((x) => x.side === 1)
    // The arm is two meshes now, so find the real ends rather than assuming the
    // first mesh spans the whole thing -- with the joint near the cheekbone the
    // front piece stops less than a centimetre back.
    const ends = () => {
      let hinge = null, tip = null
      for (const mesh of h.meshes) {
        const p = mesh.geometry.attributes.position
        for (let i = 0; i < p.count; i += 1) {
          const v = new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld)
          if (!hinge || v.z > hinge.z) hinge = v.clone()
          if (!tip || v.z < tip.z) tip = v.clone()
        }
      }
      return { hinge, tip }
    }
    root.updateMatrixWorld(true)
    const before = ends()
    applySplay(hinges, 0.15)
    root.updateMatrixWorld(true)
    const after = ends()
    expect(after.hinge.distanceTo(before.hinge)).toBeLessThan(1e-6)
    expect(after.tip.distanceTo(before.tip)).toBeGreaterThan(0.01)
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
