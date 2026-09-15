import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { RenderLoop } from '../../src/core/RenderLoop.js'
import { EAR_LANDMARKS } from '../../src/occlusion/headFrame.js'
import { SHELL_INDEX_START } from '../../src/occlusion/FaceOccluder.js'

/**
 * Eight vertices of a truncated pyramid (or, with bottom === top, a
 * parallel-walled box) standing on its side: half-width `bottom` at `y0`,
 * `top` at `y1`, extruded from `z0` to `z1`. Same shape family as
 * test/tryon/headWidth.test.js's frustum().
 */
function shellVerts(bottom, top, y0, y1, z0 = -0.1, z1 = 0.1) {
  return [
    [-bottom, y0, z0], [bottom, y0, z0], [-top, y1, z0], [top, y1, z0],
    [-bottom, y0, z1], [bottom, y0, z1], [-top, y1, z1], [top, y1, z1],
  ]
}

const SHELL_LOCAL_INDICES = [
  0, 2, 4, 4, 2, 6,   // left wall
  1, 5, 3, 5, 7, 3,   // right wall
  0, 4, 1, 1, 4, 5,   // bottom
  2, 3, 6, 6, 3, 7,   // top
  0, 1, 2, 1, 3, 2,   // front cap
  4, 6, 5, 5, 6, 7,   // back cap
]

// One past the highest EAR_LANDMARKS index (454), so the shell's own vertices
// start right after the two tragion points the real face tessellation would
// also carry at that index.
const SHELL_BASE = Math.max(...EAR_LANDMARKS) + 1

/**
 * Builds a stubbed occluder mesh whose index buffer is padded to
 * SHELL_INDEX_START with degenerate zero-area triangles -- castDistance's
 * determinant test skips these -- before the given shell's own triangles
 * begin, mirroring how the real mesh's index array is
 * [face tessellation][shell].
 *
 * @param {number[][]} verts eight shell vertices, see shellVerts()
 * @param {object} [opts]
 * @param {boolean} [opts.collapsed] place every shell vertex at the origin,
 *   so every cast misses
 */
function makeOccluderMesh(verts, { collapsed = false } = {}) {
  const vertexCount = SHELL_BASE + verts.length
  const positions = new Float32Array(vertexCount * 3)
  // Symmetric tragion points about the origin -- their average is the
  // mid-sagittal ear midpoint _openTemples measures from.
  positions[EAR_LANDMARKS[0] * 3] = -0.08
  positions[EAR_LANDMARKS[1] * 3] = 0.08

  const shell = collapsed ? verts.map(() => [0, 0, 0]) : verts
  for (let i = 0; i < shell.length; i += 1) {
    const [x, y, z] = shell[i]
    const base = (SHELL_BASE + i) * 3
    positions[base] = x
    positions[base + 1] = y
    positions[base + 2] = z
  }

  const indices = new Uint32Array(SHELL_INDEX_START + SHELL_LOCAL_INDICES.length)
  // The first SHELL_INDEX_START entries are left at 0: degenerate
  // zero-area triangles that castDistance's determinant test skips.
  for (let i = 0; i < SHELL_LOCAL_INDICES.length; i += 1) {
    indices[SHELL_INDEX_START + i] = SHELL_BASE + SHELL_LOCAL_INDICES[i]
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  mesh.visible = true
  mesh.updateMatrixWorld(true)
  return mesh
}

/** A hinge stub with just the fields buildHinges would normally supply. */
function makeHinge(armHeight) {
  return {
    side: 1,
    armLateral: 0.07,
    jointDepth: 0.12,
    group: new THREE.Object3D(),
    curl: {
      rotation: { y: 0 },
      getWorldPosition(target) {
        return target.set(0, armHeight, 0)
      },
    },
  }
}

/**
 * Builds a bare RenderLoop -- Object.create(RenderLoop.prototype), not `new
 * RenderLoop()` -- and assigns only the fields `_openTemples` reads, with the
 * hinge placed at `armHeight` above the ear midpoint, then calls it once.
 */
function buildAndSolve({ armHeight, verts, collapsed = false }) {
  const loop = Object.create(RenderLoop.prototype)
  loop._hinges = [makeHinge(armHeight)]
  loop.faceOccluder = { occluderMesh: makeOccluderMesh(verts, { collapsed }) }
  loop.headYaw = 0
  loop.glassesRoot = new THREE.Object3D()
  loop._openTemples({ quaternion: new THREE.Quaternion() })
  return loop
}

// Shape 1: a steeply sloped frustum (slope 0.3), for exactness -- the
// analytic half-width at height h above the ear midpoint is exactly
// 0.075 + 0.3 * h.
const SLOPE_VERTS = shellVerts(0.060, 0.090, -0.05, 0.05)

/** Head half-width `_openTemples` measured on the sloped frustum. */
function solveFor({ armHeight }) {
  return buildAndSolve({ armHeight, verts: SLOPE_VERTS })._headWidthMean
}

// Shape 2: a parallel-walled box, constant half-width, with vertices only at
// the two y extremes -- two rings and nothing between them, which is what the
// real shell looks like. Deliberately NOT a multiple of 5 mm: 0.080 round-
// trips through "snap to the nearest 5 mm" unchanged and would let that exact
// mutation slip past this test.
const BOX_HALF_WIDTH = 0.0791
const BOX_VERTS = shellVerts(BOX_HALF_WIDTH, BOX_HALF_WIDTH, -0.05, 0.05)

/** Head half-width `_openTemples` measured on the parallel-walled box. */
function solveForBox({ armHeight }) {
  return buildAndSolve({ armHeight, verts: BOX_VERTS })._headWidthMean
}

describe('_openTemples', () => {
  it('reads the true half-width at the temple\'s own height', () => {
    // Tight, and on a steep slope, because this is the anti-quantisation test:
    // a measurement that snaps to a vertex ring or rounds to the nearest few
    // millimetres passes any loose tolerance. Snapping halfWidthAt's result to
    // 5 mm -- the size of the original bug's step -- must fail this.
    for (const h of [-0.02, 0, 0.02, 0.03]) {
      expect(solveFor({ armHeight: h }), `height ${h}`).toBeCloseTo(0.075 + 0.3 * h, 4)
    }
  })

  it('reads a parallel-walled head identically at every temple height', () => {
    // THE regression, stated exactly. The old measurement took the widest shell
    // VERTEX inside an 8 mm slab; this box has vertices only at its two ends, so
    // a slab between them finds nothing. The same head read 72.5 / 84.9 / 94.4 mm
    // across three frames purely because their temples sit at different heights.
    for (const h of [-0.03, -0.01, 0.01, 0.03]) {
      expect(solveForBox({ armHeight: h }), `height ${h}`).toBeCloseTo(BOX_HALF_WIDTH, 4)
    }
  })

  it('returns without setting _splayAngle when the shell is collapsed', () => {
    // Every shell vertex at the origin makes every shell triangle zero-area,
    // so every cast misses and halfWidthAt returns null -- the method has to
    // bail out before touching _headWidthMean or _splayAngle, not act on a
    // measurement it does not have.
    const loop = buildAndSolve({ armHeight: 0.010, verts: SLOPE_VERTS, collapsed: true })
    expect(loop._splayAngle).toBeUndefined()
    expect(loop._headWidthMean).toBeUndefined()
  })

  it('solves immediately, latches after ten samples, and re-solves when scale changes', () => {
    const loop = Object.create(RenderLoop.prototype)
    loop._hinges = [makeHinge(0)]
    loop.faceOccluder = { occluderMesh: makeOccluderMesh(BOX_VERTS) }
    loop.headYaw = 0
    loop.glassesRoot = new THREE.Object3D()
    const transform = { quaternion: new THREE.Quaternion() }

    for (let i = 0; i < 9; i += 1) loop._openTemples(transform)
    expect(loop._hinges[0].group.rotation.y).not.toBe(0)
    expect(loop._splayForWidth).toBeUndefined()

    loop._openTemples(transform)
    expect(loop._splayForWidth).toBeCloseTo(BOX_HALF_WIDTH, 4)
    expect(loop._splayForScale).toBe(1)
    const firstAngle = loop._splayAngle

    loop.glassesRoot.scale.setScalar(1.03)
    loop._openTemples(transform)
    expect(loop._splayAngle).not.toBeCloseTo(firstAngle, 6)
    expect(loop._splayForScale).toBeCloseTo(1.03, 8)
  })

  it('lowers the temple floor when the current model has no hinges', () => {
    const loop = Object.create(RenderLoop.prototype)
    const calls = []
    loop._hinges = []
    loop.faceOccluder = { aimTempleFloor: (direction) => calls.push(direction) }
    loop._clipNearArm({})
    expect(calls).toEqual([null])
  })
})
