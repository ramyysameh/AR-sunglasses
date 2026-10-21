import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  DEFAULT_EAR_PROTRUSION,
  EAR_VERTEX_COUNT,
  FACE_OVAL_RING,
  RING_LENGTH,
  earBoxTriangles,
  earBoxVertices,
  resolveEarProtrusion,
} from '../../src/occlusion/headShell.js'
import { FaceOccluder, OCCLUDER_RENDER_ORDER } from '../../src/occlusion/FaceOccluder.js'

// Measured head-local on the aviator, frontal mock frame, in metres: the two
// tragions 9.4 mm lopsided, and the ear sleeve's extent (identical per side, so
// one box mirrored), which drew as an amber speck beside the head.
const TRAGION_WIDE = { x: 0.0993, y: -0.0161, z: -0.0592 }
const TRAGION_NARROW = { x: -0.0899, y: -0.0162, z: -0.0568 }
const SPAN = 0.1892
const SLEEVE = { x: [0.0923, 0.1116], y: [-0.0284, 0.0037], z: [-0.137, -0.0778] }

/** Per side: [minX, maxX, minY, maxY, minZ, maxZ] of each 8-corner box. */
function boxes(vertices) {
  return [0, 8].map((base) => {
    const b = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity]
    for (let c = 0; c < 8; c += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const v = vertices[(base + c) * 3 + axis]
        b[axis * 2] = Math.min(b[axis * 2], v)
        b[axis * 2 + 1] = Math.max(b[axis * 2 + 1], v)
      }
    }
    return b
  })
}

describe('earBoxVertices', () => {
  it('places both ears symmetrically even when the tragions are lopsided', () => {
    const [neg, pos] = boxes(earBoxVertices(TRAGION_WIDE, TRAGION_NARROW, SPAN, DEFAULT_EAR_PROTRUSION))
    expect(neg[0]).toBeCloseTo(-pos[1], 6)
    expect(neg[1]).toBeCloseTo(-pos[0], 6)
    // Same height and depth on both sides.
    expect(neg.slice(2)).toEqual(pos.slice(2))
  })

  it("encloses the measured ear sleeve on both sides -- the speck's whole extent", () => {
    const [neg, pos] = boxes(earBoxVertices(TRAGION_WIDE, TRAGION_NARROW, SPAN, DEFAULT_EAR_PROTRUSION))
    for (const [side, b] of [[-1, neg], [1, pos]]) {
      const xs = SLEEVE.x.map((x) => side * x).sort((a, b) => a - b)
      expect(b[0]).toBeLessThan(xs[0])
      expect(b[1]).toBeGreaterThan(xs[1])
      expect(b[2]).toBeLessThan(SLEEVE.y[0])
      expect(b[3]).toBeGreaterThan(SLEEVE.y[1])
      expect(b[4]).toBeLessThan(SLEEVE.z[0])
      expect(b[5]).toBeGreaterThan(SLEEVE.z[1])
    }
  })

  it('starts behind the tragion, so the arm in front of the ear is never covered', () => {
    const [box] = boxes(earBoxVertices(TRAGION_WIDE, TRAGION_NARROW, SPAN, DEFAULT_EAR_PROTRUSION))
    expect(box[5]).toBeLessThan(Math.min(TRAGION_WIDE.z, TRAGION_NARROW.z))
  })

  it('sinks its inner face into the skull, leaving no slit beside the shell', () => {
    const [, pos] = boxes(earBoxVertices(TRAGION_WIDE, TRAGION_NARROW, SPAN, DEFAULT_EAR_PROTRUSION))
    expect(pos[0]).toBeLessThan((TRAGION_WIDE.x - TRAGION_NARROW.x) / 2)
  })

  it('collapses to nothing when the ears are switched off', () => {
    const off = earBoxVertices(TRAGION_WIDE, TRAGION_NARROW, SPAN, 0)
    expect(Array.from(off).every((v) => v === 0)).toBe(true)
  })
})

describe('earBoxTriangles', () => {
  it('closes both boxes: 12 triangles each, every edge shared by exactly two', () => {
    const indices = earBoxTriangles()
    expect(indices.length).toBe(2 * 12 * 3)
    expect(Math.max(...indices)).toBe(EAR_VERTEX_COUNT - 1)
    const edges = new Map()
    for (let t = 0; t < indices.length; t += 3) {
      for (let e = 0; e < 3; e += 1) {
        const a = indices[t + e]
        const b = indices[t + ((e + 1) % 3)]
        const key = a < b ? `${a}-${b}` : `${b}-${a}`
        edges.set(key, (edges.get(key) ?? 0) + 1)
      }
    }
    expect([...edges.values()].every((n) => n === 2)).toBe(true)
  })
})

describe('?earwide', () => {
  it('defaults, and treats 0 as a real value so the ears can be switched off', () => {
    expect(resolveEarProtrusion('')).toBe(DEFAULT_EAR_PROTRUSION)
    expect(resolveEarProtrusion('?earwide=0')).toBe(0)
    expect(resolveEarProtrusion('?earwide=0.2')).toBeCloseTo(0.2)
    expect(resolveEarProtrusion('?earwide=abc')).toBe(DEFAULT_EAR_PROTRUSION)
  })
})

/** A face whose head origin is at (0, 0.025, 0) and whose tragions are lopsided. */
function lopsidedFace() {
  const points = Array.from({ length: 478 }, () => ({ x: 0, y: 0, z: 0 }))
  FACE_OVAL_RING.forEach((landmark, k) => {
    const a = (2 * Math.PI * k) / RING_LENGTH
    points[landmark] = { x: 0.09 * Math.sin(a), y: 0.1 * Math.cos(a), z: 0 }
  })
  points[10] = { x: 0, y: 0.1, z: 0 } // forehead; one of the head-origin points
  points[234] = { x: TRAGION_NARROW.x, y: TRAGION_NARROW.y + 0.025, z: TRAGION_NARROW.z }
  points[454] = { x: TRAGION_WIDE.x, y: TRAGION_WIDE.y + 0.025, z: TRAGION_WIDE.z }
  return points
}

async function makeOccluder(options = {}) {
  return new FaceOccluder(options).init(new THREE.Scene())
}

function earPositions(occluder) {
  return occluder.earOccluderMesh.geometry.attributes.position.array
}

describe('FaceOccluder outer ears', () => {
  it('is its own depth-only mesh, drawn with the shell and kept out of the floor', async () => {
    const occluder = await makeOccluder()
    const ears = occluder.earOccluderMesh
    expect(ears.renderOrder).toBe(OCCLUDER_RENDER_ORDER)
    expect(ears.material.colorWrite).toBe(false)
    expect(ears.material.depthWrite).toBe(true)
    // The floor and the head-width cast both read the shell's geometry; the ears
    // must not widen either.
    expect(ears.geometry).not.toBe(occluder.occluderMesh.geometry)
    expect(ears.geometry).not.toBe(occluder.innerOccluderMesh.geometry)
    expect(ears.parent).toBe(occluder.scene)
  })

  it('poses symmetric ears about the head origin from a lopsided face', async () => {
    const occluder = await makeOccluder()
    occluder.updateFromFaceMesh(lopsidedFace(), {}, 1, null, new THREE.Quaternion())

    const [neg, pos] = boxes(earPositions(occluder))
    // Origin x is 0, so the two boxes mirror about x = 0.
    expect(neg[0]).toBeCloseTo(-pos[1], 6)
    expect(neg[1]).toBeCloseTo(-pos[0], 6)
    expect(pos[1]).toBeGreaterThan(SLEEVE.x[1])
  })

  it('turns with the head: a rotated face gives the same ears, rotated', async () => {
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6)
    const origin = new THREE.Vector3(0, 0.025, 0)
    const rotate = (p) => new THREE.Vector3(p.x, p.y, p.z).sub(origin).applyQuaternion(turn).add(origin)

    const straight = await makeOccluder()
    straight.updateFromFaceMesh(lopsidedFace(), {}, 1, null, new THREE.Quaternion())
    const turned = await makeOccluder()
    turned.updateFromFaceMesh(lopsidedFace().map(rotate), {}, 1, null, turn)

    const a = earPositions(straight)
    const b = earPositions(turned)
    for (let v = 0; v < EAR_VERTEX_COUNT; v += 1) {
      const expected = rotate({ x: a[v * 3], y: a[v * 3 + 1], z: a[v * 3 + 2] })
      expect(b[v * 3]).toBeCloseTo(expected.x, 6)
      expect(b[v * 3 + 1]).toBeCloseTo(expected.y, 6)
      expect(b[v * 3 + 2]).toBeCloseTo(expected.z, 6)
    }
  })

  it('folds away with the shell when no head rotation is available', async () => {
    const occluder = await makeOccluder()
    occluder.updateFromFaceMesh(lopsidedFace(), {}, 1, null, null)
    const p = earPositions(occluder)
    const shell = occluder.occluderMesh.geometry.attributes.position
    for (let v = 0; v < EAR_VERTEX_COUNT; v += 1) {
      expect(p[v * 3]).toBeCloseTo(shell.getX(0))
      expect(p[v * 3 + 2]).toBeCloseTo(shell.getZ(0))
    }
  })

  it('hides and shows with the shell, so a probe pass with the occluder off is truly off', async () => {
    const occluder = await makeOccluder()
    occluder.updateFromFaceMesh(lopsidedFace(), {}, 1, null, new THREE.Quaternion())
    expect(occluder.earOccluderMesh.visible).toBe(true)
    occluder.hide()
    expect(occluder.earOccluderMesh.visible).toBe(false)
    occluder.show()
    expect(occluder.earOccluderMesh.visible).toBe(true)
  })
})
