import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  HOOK_FROM,
  worldDirToLocal,
  PROFILE_BIN_M,
  SKIN_CLEARANCE_M,
  applyClearance,
  buildHeadProfile,
  clearanceFor,
  collectTemples,
  headWidthAt,
  isTempleMesh,
} from '../../src/models/templeClearance.js'

const X = { x: 1, y: 0, z: 0 }
const Z = { x: 0, y: 0, z: 1 }
const ORIGIN = { x: 0, y: 0, z: 0 }

/** Minimal stand-in for a BufferAttribute. */
function attr(points) {
  return {
    count: points.length,
    getX: (i) => points[i][0],
    getY: (i) => points[i][1],
    getZ: (i) => points[i][2],
  }
}

describe('buildHeadProfile', () => {
  it('records the widest point in each depth bin', () => {
    const profile = buildHeadProfile(
      attr([[0.05, 0, 0], [0.09, 0, 0], [-0.07, 0, 0], [0.03, 0, 0.02]]),
      ORIGIN, X, Z
    )
    expect(profile.get(0)).toBeCloseTo(0.09)
    expect(profile.get(2)).toBeCloseTo(0.03)
  })

  it('takes width as absolute, so both sides feed the same profile', () => {
    const profile = buildHeadProfile(attr([[-0.11, 0, 0]]), ORIGIN, X, Z)
    expect(profile.get(0)).toBeCloseTo(0.11)
  })
})

describe('headWidthAt', () => {
  const profile = new Map([[0, 0.09], [1, 0.07]])

  it('interpolates between bins rather than stepping', () => {
    expect(headWidthAt(profile, PROFILE_BIN_M * 0.5)).toBeCloseTo(0.08)
  })

  it('returns 0 where the head was never measured', () => {
    // No data must mean NO constraint. Inventing a width here would push arms
    // out against a head that does not exist -- the failure mode of the earlier
    // global attempts.
    expect(headWidthAt(profile, 1.0)).toBe(0)
    expect(headWidthAt(new Map(), 0)).toBe(0)
  })
})

describe('clearanceFor', () => {
  const profile = new Map([[0, 0.09]])

  it('pushes a buried vertex out to the skin plus clearance', () => {
    expect(clearanceFor(0.085, 0, 0.3, profile)).toBeCloseTo(0.09 + SKIN_CLEARANCE_M - 0.085)
  })

  it('leaves a vertex that already clears the head alone', () => {
    expect(clearanceFor(0.15, 0, 0.3, profile)).toBe(0)
  })

  it('never moves the tip, which belongs inside the head behind the ear', () => {
    // Clearing the tip would trade this bug for the temple-tip bug and drop the
    // occlusion harness back to zero rear trim.
    expect(clearanceFor(0.0, 0, HOOK_FROM, profile)).toBe(0)
    expect(clearanceFor(0.0, 0, 1, profile)).toBe(0)
  })

  it('does nothing at a depth the profile does not cover', () => {
    expect(clearanceFor(0.01, 5, 0.3, profile)).toBe(0)
  })
})

function makeGlasses() {
  const root = new THREE.Group()
  for (const side of [-1, 1]) {
    const pts = []
    for (let i = 0; i <= 10; i += 1) pts.push(side * 0.05, 0, -0.01 * i)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pts), 3))
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial())
    m.name = side < 0 ? '04_Temple_Left' : '05_Temple_Right'
    root.add(m)
  }
  const lens = new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute(
      'position', new THREE.BufferAttribute(Float32Array.from([0.02, 0, 0]), 3)
    ),
    new THREE.MeshBasicMaterial()
  )
  lens.name = '02_Lens_Left'
  root.add(lens)
  root.updateWorldMatrix(true, true)
  return root
}

describe('isTempleMesh', () => {
  it('matches arms and hinges, not lenses', () => {
    expect(makeGlasses().children.filter(isTempleMesh).map((m) => m.name))
      .toEqual(['04_Temple_Left', '05_Temple_Right'])
  })
})

describe('applyClearance', () => {
  // A head 0.09 wide everywhere the arm runs.
  const profile = new Map()
  for (let b = -12; b <= 2; b += 1) profile.set(b, 0.09)
  const frame = () => ({
    mid: ORIGIN, axX: X, axZ: Z,
    tmp: new THREE.Vector3(), local: new THREE.Vector3(),
  })

  it('pushes buried vertices out to the head plus clearance, on both sides', () => {
    const temples = collectTemples(makeGlasses())
    const { moved } = applyClearance(temples, profile, frame())
    expect(moved).toBeGreaterThan(0)
    for (const { mesh } of temples) {
      const p = mesh.geometry.attributes.position
      expect(Math.abs(p.getX(0))).toBeCloseTo(0.09 + SKIN_CLEARANCE_M)
      // Never crosses the midline.
      expect(Math.sign(p.getX(0))).toBe(Math.sign(temples[0].original[0]) * (mesh.name.includes('Right') ? -1 : 1))
    }
  })

  it('leaves the tip inside the head so the ear can still hide it', () => {
    const temples = collectTemples(makeGlasses())
    applyClearance(temples, profile, frame())
    const p = temples[0].mesh.geometry.attributes.position
    // Last vertex is t = 1, past HOOK_FROM: untouched at its original 0.05.
    expect(Math.abs(p.getX(p.count - 1))).toBeCloseTo(0.05)
  })

  it('leaves an arm that already clears the head completely untouched', () => {
    const narrow = new Map()
    for (let b = -12; b <= 2; b += 1) narrow.set(b, 0.01)
    const temples = collectTemples(makeGlasses())
    const { moved } = applyClearance(temples, narrow, frame())
    expect(moved).toBe(0)
    const p = temples[0].mesh.geometry.attributes.position
    expect(Math.abs(p.getX(3))).toBeCloseTo(0.05)
  })

  it('rebuilds from the originals, so repeated solves cannot accumulate', () => {
    const temples = collectTemples(makeGlasses())
    const f = frame()
    applyClearance(temples, profile, f)
    applyClearance(temples, profile, f)
    applyClearance(temples, profile, f)
    const p = temples[0].mesh.geometry.attributes.position
    expect(Math.abs(p.getX(0))).toBeCloseTo(0.09 + SKIN_CLEARANCE_M)
  })

  it('accounts for the render scale, so the world gap is scale-independent', () => {
    const root = makeGlasses()
    root.scale.setScalar(2)
    root.updateWorldMatrix(true, true)
    const temples = collectTemples(root)
    applyClearance(temples, profile, frame())
    const p = temples[0].mesh.geometry.attributes.position
    // The vertex already sits at 0.10 in world; it needs to reach 0.094, so it
    // is ALREADY clear and must not move.
    expect(Math.abs(p.getX(0))).toBeCloseTo(0.05)
  })

  it('pushes along the head axis even when the mesh has its own rotation', () => {
    // A real merchant export nests temples under rotated nodes. Writing the push
    // into local X then moves the vertex along the wrong axis, which left one
    // model 15 mm inside the head while the code reported success.
    const root = makeGlasses()
    const arm = root.children.find((c) => c.name === '05_Temple_Right')
    arm.rotation.z = Math.PI / 2 // local X now points along world Y
    root.updateWorldMatrix(true, true)
    const temples = collectTemples(root).filter((t) => t.mesh === arm)
    applyClearance(temples, profile, frame())

    const p = arm.geometry.attributes.position
    const world = new THREE.Vector3().fromBufferAttribute(p, 0).applyMatrix4(arm.matrixWorld)
    expect(Math.abs(world.x)).toBeCloseTo(0.09 + SKIN_CLEARANCE_M)
  })

  it('moves vertices only sideways', () => {
    const temples = collectTemples(makeGlasses())
    applyClearance(temples, profile, frame())
    const p = temples[0].mesh.geometry.attributes.position
    expect(p.getY(0)).toBeCloseTo(0)
    expect(p.getZ(5)).toBeCloseTo(-0.05)
  })
})

describe('worldDirToLocal', () => {
  const out = { x: 0, y: 0, z: 0 }

  it('is the identity for an untransformed mesh', () => {
    const m = new THREE.Matrix4()
    expect(worldDirToLocal(m.elements, 0.02, 0, 0, out)).toBe(true)
    expect(out.x).toBeCloseTo(0.02)
    expect(out.y).toBeCloseTo(0)
  })

  it('undoes rotation, so a world push lands on the right local axis', () => {
    const m = new THREE.Matrix4().makeRotationZ(Math.PI / 2)
    worldDirToLocal(m.elements, 0.02, 0, 0, out)
    // World +X is local -Y after a +90 degree Z rotation.
    expect(out.x).toBeCloseTo(0)
    expect(out.y).toBeCloseTo(-0.02)
  })

  it('undoes scale, so the world distance is what was asked for', () => {
    const m = new THREE.Matrix4().makeScale(2, 2, 2)
    worldDirToLocal(m.elements, 0.02, 0, 0, out)
    expect(out.x).toBeCloseTo(0.01)
  })

  it('reports failure on a singular matrix instead of emitting NaN', () => {
    const m = new THREE.Matrix4().makeScale(0, 0, 0)
    expect(worldDirToLocal(m.elements, 1, 0, 0, out)).toBe(false)
  })
})

describe('multi-part arms', () => {
  const profile = new Map()
  for (let b = -12; b <= 2; b += 1) profile.set(b, 0.09)
  const frame = () => ({
    mid: ORIGIN, axX: X, axZ: Z,
    tmp: new THREE.Vector3(), local: new THREE.Vector3(),
  })

  /** One arm split into two meshes, front half and back half. */
  function splitArm() {
    const root = new THREE.Group()
    for (const [name, from, to] of [['04_Temple_Front', 0, 5], ['04_Temple_Rear', 5, 10]]) {
      const pts = []
      for (let i = from; i <= to; i += 1) pts.push(0.05, 0, -0.01 * i)
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pts), 3))
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial())
      m.name = name
      root.add(m)
    }
    root.updateWorldMatrix(true, true)
    return root
  }

  it('measures position along the WHOLE arm, not within each part', () => {
    // The front part's own rear vertices must not be mistaken for the tip.
    // Measured per-mesh they score t = 1 and get skipped; measured across the
    // arm they are barely halfway and must be pushed clear.
    const root = splitArm()
    const temples = collectTemples(root)
    expect(temples).toHaveLength(2)
    applyClearance(temples, profile, frame())

    const front = root.children[0].geometry.attributes.position
    for (let i = 0; i < front.count; i += 1) {
      expect(front.getX(i)).toBeCloseTo(0.09 + SKIN_CLEARANCE_M)
    }
  })

  it('still exempts the true tip, which lives in the rear part', () => {
    const root = splitArm()
    const temples = collectTemples(root)
    applyClearance(temples, profile, frame())
    const rear = root.children[1].geometry.attributes.position
    expect(rear.getX(rear.count - 1)).toBeCloseTo(0.05)
  })
})

describe('geometric arm detection', () => {
  /**
   * A frame whose parts are named so the /temple|hinge/ regex matches nothing.
   * Front slab sits at z >= -0.01; arms run back to z = -0.13.
   */
  function frameNamed(armName, extra = []) {
    const root = new THREE.Group()
    const add = (name, pts) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pts), 3))
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial())
      m.name = name
      root.add(m)
    }
    // front frame + lenses: at the front, full width, never reaching back
    add('Front', [-0.07, 0, 0.01, 0.07, 0, 0.01, 0, 0.02, 0.0])
    add('Lens_L', [-0.065, -0.02, 0.008, -0.011, -0.02, 0.008, -0.04, 0.01, 0.005])
    add('Lens_R', [0.065, -0.02, 0.008, 0.011, -0.02, 0.008, 0.04, 0.01, 0.005])
    // nose pads: behind the front slab but ON the centreline -- must NOT be arms
    add('NosePad_L', [-0.006, -0.02, -0.004, -0.009, -0.03, -0.008, -0.005, -0.025, -0.006])
    add('NosePad_R', [0.006, -0.02, -0.004, 0.009, -0.03, -0.008, 0.005, -0.025, -0.006])
    for (const [n, p] of extra) add(n, p)
    // the arms themselves
    for (const side of [-1, 1]) {
      const pts = []
      for (let i = 0; i <= 10; i += 1) pts.push(side * 0.069, 0, -0.013 * i)
      add(`${armName}_${side < 0 ? 'L' : 'R'}`, pts)
    }
    root.updateWorldMatrix(true, true)
    return root
  }

  it('finds arms the name regex misses', () => {
    // "Branche" (fr), "Buegel" (de), "Asta" (it) are all real supplier names.
    for (const name of ['Arm', 'Side', 'Branche', 'Buegel', 'Asta']) {
      const found = collectTemples(frameNamed(name)).map((t) => t.mesh.name).sort()
      expect(found).toEqual([`${name}_L`, `${name}_R`])
    }
  })

  it('never selects lenses, the front, or the nose pads', () => {
    const found = collectTemples(frameNamed('Arm')).map((t) => t.mesh.name)
    // Nose pads matter most: they sit near the centreline, where the head profile
    // at their depth is the CHEEK width. Pushing one "clear" would fling it ~60 mm
    // sideways off the nose.
    for (const forbidden of ['Front', 'Lens_L', 'Lens_R', 'NosePad_L', 'NosePad_R']) {
      expect(found).not.toContain(forbidden)
    }
  })

  it('prefers the named set when it contains real arms', () => {
    const root = frameNamed('Temple')
    const found = collectTemples(root).map((t) => t.mesh.name).sort()
    expect(found).toEqual(['Temple_L', 'Temple_R'])
  })

  it('falls back when the only name matches are front-slab hardware', () => {
    // Hinge pins are named, the arms are not. Trusting the name match here would
    // hand the clearance pass two tiny parts at the front and no arms at all --
    // the silent no-op this fallback exists to prevent.
    const root = frameNamed('Arm', [
      ['Hinge_Pin_L', [-0.066, 0, 0.004, -0.068, 0.002, 0.006, -0.067, -0.002, 0.005]],
      ['Hinge_Pin_R', [0.066, 0, 0.004, 0.068, 0.002, 0.006, 0.067, -0.002, 0.005]],
    ])
    const found = collectTemples(root).map((t) => t.mesh.name).sort()
    expect(found).toEqual(['Arm_L', 'Arm_R'])
  })

  it('returns nothing rather than guessing when there is no geometry at all', () => {
    expect(collectTemples(new THREE.Group())).toEqual([])
  })
})
