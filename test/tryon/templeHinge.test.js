import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  MAX_CURL_RAD,
  TEMPLE_ON_TOP_ORDER,
  MAX_SPLAY_RAD,
  TEMPLE_CURL_RAD,
  TEMPLE_CUT_RATIO,
  TEMPLE_SHELL_CLEARANCE,
  applyCurl,
  applyNearArmClip,
  solveSplay,
  applySplay,
  buildHinges,
  isTempleMesh,
  selectArms,
} from '../../src/models/templeHinge.js'
import { OCCLUDER_RENDER_ORDER } from '../../src/occlusion/FaceOccluder.js'

const X = { x: 1, y: 0, z: 0 }
const Z = { x: 0, y: 0, z: 1 }
const ORIGIN = { x: 0, y: 0, z: 0 }

function attr(points) {
  return { count: points.length, getX: (i) => points[i][0], getY: (i) => points[i][1], getZ: (i) => points[i][2] }
}

describe('solveSplay', () => {
  const deg = (rad) => (rad * 180) / Math.PI
  // Measured in the harness on the mock head, `?probe=1&mock=turn`, after the
  // shell-only cast landed.
  const HEAD = 0.0919   // ray-cast shell half-width on the mock head, world units
  const ARM = 0.0772    // gripz, at the joint, after model scale
  const JOINT = 0.1243  // gripz

  it('places the arm outside the SHELL, which is what culls it', () => {
    // Aiming at the skin instead put the arm inside the shell, and the shell ate
    // it: Willow at -39 deg yaw measured earGapRatio +0.122 with 41% of the
    // temple hidden, against -0.030 and 27% at the clearance used here.
    const target = HEAD + TEMPLE_SHELL_CLEARANCE
    expect(solveSplay(HEAD, ARM, JOINT)).toBeCloseTo(Math.asin((target - ARM) / JOINT), 9)
  })

  it('gives two frames on the same head nearly the same opening', () => {
    // The whole point. Two frames differing only in where their arms sit
    // should differ in splay by a few degrees, not by fifteen.
    const gripz = deg(solveSplay(HEAD, 0.0772, 0.1243))
    const willow = deg(solveSplay(HEAD, 0.0753, 0.1339))
    expect(Math.abs(gripz - willow)).toBeLessThan(6)
  })

  it('never opens past the ceiling, however bad the measurement', () => {
    // toBe, not toBeLessThanOrEqual: this also catches a clamp applied too
    // early, which would silently pass a looser bound.
    expect(solveSplay(0.13, 0.02, 0.05)).toBe(MAX_SPLAY_RAD)
  })

  it('stays shut on a measurement it cannot use', () => {
    expect(solveSplay(HEAD, ARM, 0)).toBe(0)
    expect(solveSplay(0, ARM, JOINT)).toBe(0)
    expect(solveSplay(HEAD, Number.NaN, JOINT)).toBe(0)
  })

  it('never folds the arm inward when the frame is already wider than the head', () => {
    // A frame wider than the face asks for a NEGATIVE reach. Bending the arm in
    // to meet the skin would clamp it through the cheek.
    expect(solveSplay(0.06, 0.09, JOINT)).toBe(0)
  })
})

describe('applyNearArmClip', () => {
  const arm = () => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3))
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial())
    new THREE.Group().add(m)
    return m
  }
  const hinges = () => [
    { side: -1, meshes: [arm(), arm()] },
    { side: 1, meshes: [arm(), arm()] },
  ]
  const FRONT = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
  const BACK = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)

  it('draws the near arm before the occluder and clips it, leaving the far arm alone', () => {
    const h = hinges()
    applyNearArmClip(h, -1, FRONT, BACK)
    for (const m of h[0].meshes) {
      expect(m.renderOrder).toBe(TEMPLE_ON_TOP_ORDER)
      expect(m.material.clippingPlanes).toEqual([FRONT])
    }
    for (const m of h[1].meshes) {
      expect(m.renderOrder).toBe(0)
      expect(m.material.clippingPlanes).toBeNull()
    }
  })

  it('draws the stretch behind the ear normally, so the ear hides the cut', () => {
    // Discarding it instead leaves a hard diagonal edge on the cheek wherever
    // the ear does not cover the cut -- plainly visible at +/-25 deg of pitch.
    const h = hinges()
    applyNearArmClip(h, -1, FRONT, BACK)
    for (const m of h[0].meshes) {
      const behind = m.userData.templeBehind
      expect(behind).toBeTruthy()
      expect(behind.visible).toBe(true)
      expect(behind.renderOrder).toBe(0)
      expect(behind.material.clippingPlanes).toEqual([BACK])
      expect(behind.geometry).toBe(m.geometry)
    }
  })

  it('hides the behind-ear sibling on the far arm', () => {
    const h = hinges()
    applyNearArmClip(h, -1, FRONT, BACK)
    for (const m of h[1].meshes) expect(m.userData.templeBehind.visible).toBe(false)
  })

  it('never lifts BOTH arms, which is what showed the far one through the head', () => {
    // Applied to both, 651 of the far arm's 1529 pixels drew through the skull.
    const h = hinges()
    applyNearArmClip(h, 1, FRONT, BACK)
    const lifted = h.filter((x) => x.meshes.some((m) => m.renderOrder === TEMPLE_ON_TOP_ORDER))
    expect(lifted).toHaveLength(1)
    expect(lifted[0].side).toBe(1)
  })

  it('lifts neither arm when the head is too frontal to have a near side', () => {
    const h = hinges()
    applyNearArmClip(h, 0, FRONT, BACK)
    for (const hinge of h) {
      for (const m of hinge.meshes) {
        expect(m.renderOrder).toBe(0)
        expect(m.userData.templeBehind.visible).toBe(false)
      }
    }
  })

  it('clones the material and the sibling once each', () => {
    const h = hinges()
    const first = h[0].meshes[0].material
    applyNearArmClip(h, -1, FRONT, BACK)
    const cloned = h[0].meshes[0].material
    const sibling = h[0].meshes[0].userData.templeBehind
    expect(cloned).not.toBe(first)
    applyNearArmClip(h, -1, FRONT, BACK)
    expect(h[0].meshes[0].material).toBe(cloned)
    expect(h[0].meshes[0].userData.templeBehind).toBe(sibling)
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
      const authoredTipZ = -0.013 * 11
      expect(h.cutZ).toBeCloseTo(h.hingeLocal.z - (h.hingeLocal.z - authoredTipZ) * TEMPLE_CUT_RATIO, 6)
    }
  })

  it('pins the measured articulation point used by all merchant models', () => {
    expect(TEMPLE_CUT_RATIO).toBe(0.66)
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

/**
 * The rules that make the head solid to a temple arm.
 *
 * Every one of these was a bug first. They are asserted here rather than left
 * to a reviewer's eye because each is a single number or flag in a different
 * file, each looks harmless on its own, and the symptom -- an arm drawn
 * straight through the skull, or an arm eaten from the cheek back -- only
 * appears on a face at an angle, which no unit test renders.
 */
describe('occluder contract: a temple can never draw through the head', () => {
  const arm = () => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3))
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial())
    new THREE.Group().add(m)
    return m
  }
  const hinges = () => [
    { side: -1, meshes: [arm(), arm()] },
    { side: 1, meshes: [arm(), arm()] },
  ]
  const FRONT = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
  const BACK = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)

  /** Every temple mesh the clip touches, front pieces and behind-siblings alike. */
  const allPieces = (h) => h.flatMap((hinge) => hinge.meshes.flatMap(
    (m) => [m, m.userData.templeBehind].filter(Boolean)
  ))

  it('lifts a temple above the shell ONLY by drawing earlier, never by ignoring depth', () => {
    // The tempting one-line "fix" for an eaten arm is depthTest:false, and it
    // works -- the arm then also draws over the nose, the cheek and the far
    // lens. Drawing earlier is the only lift that still respects the rest of
    // the scene.
    const h = hinges()
    applyNearArmClip(h, -1, FRONT, BACK)
    for (const piece of allPieces(h)) {
      expect(piece.material.depthTest).toBe(true)
      expect(piece.material.depthWrite).toBe(true)
    }
  })

  it('keeps the lifted order strictly ahead of the shell, across the two modules', () => {
    // The shell only hides what draws AFTER it. These two numbers live in
    // different files; if they ever meet, the near arm silently goes back to
    // being eaten at the cheek, and if the shell's were to drop below, every
    // arm would draw through the skull.
    expect(TEMPLE_ON_TOP_ORDER).toBeLessThan(OCCLUDER_RENDER_ORDER)
  })

  it('leaves every piece it does not lift behind the shell, where the head hides it', () => {
    const h = hinges()
    applyNearArmClip(h, -1, FRONT, BACK)
    const lifted = allPieces(h).filter((p) => p.renderOrder === TEMPLE_ON_TOP_ORDER)
    const rest = allPieces(h).filter((p) => p.renderOrder !== TEMPLE_ON_TOP_ORDER)
    expect(lifted.length).toBeGreaterThan(0)
    for (const piece of rest) expect(piece.renderOrder).toBeGreaterThan(OCCLUDER_RENDER_ORDER)
  })

  it('never lifts a piece that is not clipped to the front of the ear', () => {
    // An unclipped lift is the whole arm in front of the face, tip included --
    // it reads as a stick growing out of the cheek.
    const h = hinges()
    applyNearArmClip(h, -1, FRONT, BACK)
    for (const piece of allPieces(h)) {
      if (piece.renderOrder !== TEMPLE_ON_TOP_ORDER) continue
      expect(piece.material.clippingPlanes).toEqual([FRONT])
    }
  })

  it('lifts nothing at all when the head frame is unavailable', () => {
    // Landmarks drop out between frames. Lifting on a stale or missing plane
    // puts the arm in front of the face at an angle where it should be behind
    // it, so the fallback has to be the SAFE state, not the last good one.
    for (const args of [[0, FRONT, BACK], [-1, null, BACK], [-1, null, null]]) {
      const h = hinges()
      applyNearArmClip(h, ...args)
      for (const piece of allPieces(h)) {
        expect(piece.renderOrder).toBeGreaterThan(OCCLUDER_RENDER_ORDER)
      }
    }
  })

  it("lifts one arm at most, so the far temple is always the shell's to hide", () => {
    // Lifting both put 651 of the far arm's 1529 pixels through the skull.
    for (const side of [-1, 1]) {
      const h = hinges()
      applyNearArmClip(h, side, FRONT, BACK)
      const sides = new Set(h.filter((x) => x.meshes.some((m) => m.renderOrder === TEMPLE_ON_TOP_ORDER)).map((x) => x.side))
      expect(sides.size).toBe(1)
      expect([...sides][0]).toBe(side)
    }
  })

  it('returns a lifted arm to the shell when the head turns back to frontal', () => {
    // The clip is re-evaluated every frame, so the state has to be reversible;
    // an earlier version only ever ADDED the lift, and the arm stayed in front
    // of the face for the rest of the session once any turn had happened.
    const h = hinges()
    applyNearArmClip(h, -1, FRONT, BACK)
    applyNearArmClip(h, 0, null, null)
    for (const piece of allPieces(h)) {
      expect(piece.renderOrder).toBeGreaterThan(OCCLUDER_RENDER_ORDER)
      expect(piece.material.clippingPlanes).toBeNull()
    }
  })
})

/**
 * The gate for a newly uploaded merchant frame: nothing checks a new upload
 * beyond this, so this is the last line of defense before a customer sees it.
 */
describe('solveSplay across the plausible range of merchant frames', () => {
  const deg = (rad) => (rad * 180) / Math.PI
  // Measured in the harness on the mock head, `?probe=1&mock=turn`, after the
  // shell-only cast landed.
  const HEAD = 0.0919   // ray-cast shell half-width on the mock head, world units

  /**
   * The three known-good frames, plus the extremes a merchant could upload:
   * every model is normalised to a 0.145 m frame width, so armLateral cannot
   * stray far, but jointDepth follows the temple's own length.
   */
  const FRAMES = [
    { name: 'gripz', armLateral: 0.0772, jointDepth: 0.1243 },
    { name: 'larsson', armLateral: 0.0799, jointDepth: 0.1225 },
    { name: 'willow', armLateral: 0.0753, jointDepth: 0.1339 },
    { name: 'stub temple', armLateral: 0.0772, jointDepth: 0.0700 },
    { name: 'long temple', armLateral: 0.0772, jointDepth: 0.1700 },
    { name: 'narrow arms', armLateral: 0.0650, jointDepth: 0.1241 },
    { name: 'wide arms', armLateral: 0.0900, jointDepth: 0.1241 },
  ]

  it('keeps every plausible frame inside a usable opening', () => {
    // A real band, not the trivial bounds the implementation already
    // guarantees on its own (>= 0 from the reach clamp, < MAX_SPLAY_RAD's ~34
    // deg ceiling from the asin clamp) -- either of those would pass an
    // implementation that just returned a constant 5 degrees. 5..30 deg is the
    // range an upload in this band actually has to land in to look right.
    for (const frame of FRAMES) {
      const angle = deg(solveSplay(HEAD, frame.armLateral, frame.jointDepth))
      expect(angle, frame.name).toBeGreaterThan(5)
      expect(angle, frame.name).toBeLessThan(30)
    }
  })

  it('lands the three known-good frames within a few degrees of each other', () => {
    const solved = FRAMES.slice(0, 3)
      .map((f) => deg(solveSplay(HEAD, f.armLateral, f.jointDepth)))
    expect(Math.max(...solved) - Math.min(...solved)).toBeLessThan(6)
  })

  it('opens a stubby temple more than a long one, never the reverse', () => {
    // A short temple reaches the head at a steeper angle. If this inverts, the
    // solve is keying on the wrong side of the triangle.
    const stub = solveSplay(HEAD, 0.0772, 0.0700)
    const long = solveSplay(HEAD, 0.0772, 0.1700)
    expect(stub).toBeGreaterThan(long)
  })

  it('asks for nothing when the arms already sit outside the shell', () => {
    // 0.1100 is genuinely wider than HEAD + TEMPLE_SHELL_CLEARANCE (0.1067), so
    // the reach the solve computes is negative and clamps to zero.
    expect(solveSplay(HEAD, 0.1100, 0.1241)).toBe(0)
  })

  it('pins the clearance to the value that was measured, not a derived one', () => {
    // Every other test derives its expectation FROM this constant, so they all
    // move together if it is fat-fingered. This is the only assertion that would
    // catch 0.148 for 0.0148. The value comes from a harness sweep on three
    // frames -- see the constant's own doc comment for the table.
    expect(TEMPLE_SHELL_CLEARANCE).toBe(0.0148)
  })
})
