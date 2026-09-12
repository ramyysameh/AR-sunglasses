import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  DEFAULT_SHELL_DEPTH_RATIO,
  DEFAULT_SHELL_LATERAL_RATIO,
  FACE_OVAL_RING,
  RING_LENGTH,
  resolveShellDepthRatio,
  resolveShellLateralRatio,
  shellTriangles,
  tessellationTriangles,
  templeSpan,
} from '../../src/occlusion/headShell.js'
import { FaceOccluder } from '../../src/occlusion/FaceOccluder.js'

const FACE_VERTEX_COUNT = 468

describe('shell URL overrides', () => {
  it('honors ?shelldepth and ?shellwide', () => {
    expect(resolveShellDepthRatio('?shelldepth=1.2')).toBeCloseTo(1.2)
    expect(resolveShellLateralRatio('?shellwide=0.3')).toBeCloseTo(0.3)
  })

  it('defaults when absent or unparseable', () => {
    expect(resolveShellDepthRatio('')).toBe(DEFAULT_SHELL_DEPTH_RATIO)
    expect(resolveShellLateralRatio('?shellwide=abc')).toBe(DEFAULT_SHELL_LATERAL_RATIO)
  })

  it('treats 0 as a real value so the shell can be switched off on a phone', () => {
    expect(resolveShellDepthRatio('?shelldepth=0')).toBe(0)
    expect(resolveShellLateralRatio('?shellwide=0')).toBe(0)
  })
})

describe('tessellationTriangles', () => {
  it('takes the three corners of each closed edge triple', () => {
    const tess = [
      { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 1 },
      { start: 7, end: 8 }, { start: 8, end: 9 }, { start: 9, end: 7 },
    ]
    expect(tessellationTriangles(tess)).toEqual([1, 2, 3, 7, 8, 9])
  })

  it('drops triples that are not a closed loop rather than inventing geometry', () => {
    // A reordered or malformed table should lose triangles, not produce wrong
    // ones -- a bogus depth-writing triangle across the face is far worse than
    // a missing one.
    const tess = [
      { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 99 },
      { start: 4, end: 5 }, { start: 5, end: 6 }, { start: 6, end: 4 },
    ]
    expect(tessellationTriangles(tess)).toEqual([4, 5, 6])
  })
})

describe('shellTriangles', () => {
  it('emits two wall quads and a cap triangle per ring segment', () => {
    // Two walls, not one: face oval -> ear plane -> back of the skull. A single
    // wall cannot be both wide at the ear and narrow at the occiput.
    const ring = FACE_OVAL_RING
    expect(shellTriangles(ring, 500, 600, 700)).toHaveLength(RING_LENGTH * 15)
  })

  it('stitches the ring vertices it is given, not a contiguous range', () => {
    // The ring vertices are face-mesh landmarks scattered through the buffer.
    const indices = shellTriangles([10, 20, 30], 100, 200, 300)
    expect(indices).toContain(10)
    expect(indices).toContain(20)
    expect(indices).toContain(30)
    expect(indices).toContain(300)
  })

  it('closes the loop, so the last segment wraps to the first vertex', () => {
    const tail = shellTriangles([10, 20, 30], 100, 200, 300).slice(-15)
    expect(tail).toContain(30)
    expect(tail).toContain(10)
  })
})

describe('templeSpan', () => {
  it('measures the distance between the temple landmarks', () => {
    expect(templeSpan({ x: -0.1, y: 0, z: 0 }, { x: 0.1, y: 0, z: 0 })).toBeCloseTo(0.2)
  })

  it('is zero when a landmark is missing', () => {
    expect(templeSpan(null, { x: 0.1, y: 0, z: 0 })).toBe(0)
  })
})

/** Synthetic frontal face: the oval ring laid out as a circle of radius 0.1. */
function makeFaceWorldPoints() {
  const points = new Array(478)
  for (let i = 0; i < points.length; i += 1) {
    points[i] = { x: 0, y: 0, z: 0 }
  }
  FACE_OVAL_RING.forEach((landmark, k) => {
    const a = (2 * Math.PI * k) / RING_LENGTH
    points[landmark] = { x: 0.1 * Math.cos(a), y: 0.1 * Math.sin(a), z: 0 }
  })
  points[234] = { x: -0.1, y: 0, z: 0 }
  points[454] = { x: 0.1, y: 0, z: 0 }
  return points
}

async function makeOccluder(options) {
  return new FaceOccluder(options).init(new THREE.Scene())
}

const EAR_START = FACE_VERTEX_COUNT
const BACK_START = EAR_START + RING_LENGTH
const CAP = BACK_START + RING_LENGTH
const EXTRUDED_START = EAR_START

describe('FaceOccluder head shell', () => {
  it('builds the face surface from the real tessellation, not a stand-in', async () => {
    const occluder = await makeOccluder({})
    const geometry = occluder.occluderMesh.geometry
    expect(geometry.attributes.position.count).toBe(CAP + 1)
    // 852 face triangles + 36 wall quads + 36 cap triangles, give or take any
    // tessellation triples the loader rejects.
    expect(geometry.getIndex().count / 3).toBeGreaterThan(800)
    for (const index of geometry.getIndex().array) {
      expect(index).toBeLessThan(geometry.attributes.position.count)
    }
  })

  it('extrudes each face-oval landmark backwards along the head axis', async () => {
    const occluder = await makeOccluder({
      shellDepthRatio: 0.5, shellLateralRatio: 0, shellTaper: 1, shellEarDepth: 0.33,
    })
    occluder.updateFromFaceMesh(makeFaceWorldPoints(), {}, 1, null, new THREE.Quaternion())

    const position = occluder.occluderMesh.geometry.attributes.position
    for (let k = 0; k < RING_LENGTH; k += 1) {
      const ring = FACE_OVAL_RING[k]
      // Temple span 0.2 * 0.5 = 0.1 of total depth, backwards along -Z.
      expect(position.getX(EAR_START + k)).toBeCloseTo(position.getX(ring))
      expect(position.getZ(EAR_START + k)).toBeCloseTo(position.getZ(ring) - 0.1 * 0.33)
      expect(position.getZ(BACK_START + k)).toBeCloseTo(position.getZ(ring) - 0.1)
    }
  })

  it('narrows toward the back of the head instead of sweeping a cylinder', async () => {
    // A constant-section tube is what this used to build, and at 28 degrees of
    // yaw its silhouette reached past the head entirely and swallowed the temple
    // arm from the cheekbone backwards -- the arm stopped in mid-air short of
    // the ear. Collapsing the shell made the whole arm reappear, which is what
    // identified it.
    const taper = 0.7
    const occluder = await makeOccluder({ shellDepthRatio: 0.5, shellLateralRatio: 0, shellTaper: taper })
    const points = makeFaceWorldPoints()
    occluder.updateFromFaceMesh(points, {}, 1, null, new THREE.Quaternion())

    const position = occluder.occluderMesh.geometry.attributes.position

    // Every widest ring point must have a NARROWER extruded partner. Compared as
    // an aggregate half-width rather than per vertex: the taper scales about the
    // head origin, which these fixture landmarks do not centre on, so a per-
    // vertex equality would be asserting the fixture's own geometry.
    let faceHalf = 0
    let shellHalf = 0
    for (let k = 0; k < RING_LENGTH; k += 1) {
      faceHalf = Math.max(faceHalf, Math.abs(position.getX(FACE_OVAL_RING[k])))
      shellHalf = Math.max(shellHalf, Math.abs(position.getX(BACK_START + k)))
    }
    expect(shellHalf).toBeLessThan(faceHalf)
    expect(shellHalf / faceHalf).toBeGreaterThan(taper * 0.85)
    expect(shellHalf / faceHalf).toBeLessThan(1)
  })

  it('bulges only the extruded wall, leaving the shared face vertices untouched', async () => {
    const occluder = await makeOccluder({ shellDepthRatio: 0.5, shellLateralRatio: 0.25, shellTaper: 1 })
    const points = makeFaceWorldPoints()
    occluder.updateFromFaceMesh(points, {}, 1, null, new THREE.Quaternion())

    const position = occluder.occluderMesh.geometry.attributes.position
    // The ring landmarks are part of the tessellated face: moving them would
    // tear a hole in the face surface.
    for (let k = 0; k < RING_LENGTH; k += 1) {
      const ring = FACE_OVAL_RING[k]
      expect(position.getX(ring)).toBeCloseTo(points[ring].x)
    }
    // The widest ring points must push their extruded partners outward.
    const widest = FACE_OVAL_RING.map((lm, k) => ({ lm, k })).filter(({ lm }) => Math.abs(points[lm].x) > 0.09)
    expect(widest.length).toBeGreaterThan(0)
    for (const { lm, k } of widest) {
      expect(Math.abs(position.getX(EXTRUDED_START + k))).toBeGreaterThan(Math.abs(points[lm].x))
    }
  })

  it('seals the back with a cap at the mean of the extruded ring', async () => {
    const occluder = await makeOccluder({ shellDepthRatio: 0.5, shellLateralRatio: 0, shellTaper: 1 })
    occluder.updateFromFaceMesh(makeFaceWorldPoints(), {}, 1, null, new THREE.Quaternion())

    const position = occluder.occluderMesh.geometry.attributes.position
    let sx = 0
    let sz = 0
    for (let k = 0; k < RING_LENGTH; k += 1) {
      sx += position.getX(BACK_START + k)
      sz += position.getZ(BACK_START + k)
    }
    expect(position.getX(CAP)).toBeCloseTo(sx / RING_LENGTH)
    expect(position.getZ(CAP)).toBeCloseTo(sz / RING_LENGTH)
  })

  it('follows the head rotation it is handed', async () => {
    const occluder = await makeOccluder({
      shellDepthRatio: 0.5, shellLateralRatio: 0, shellTaper: 1, shellEarDepth: 0.33,
    })
    const yawed = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0))
    occluder.updateFromFaceMesh(makeFaceWorldPoints(), {}, 1, null, yawed)

    const position = occluder.occluderMesh.geometry.attributes.position
    const ring = FACE_OVAL_RING[0]
    // Yawed 90 degrees: "backwards" is now -X, not -Z. Both rings follow it.
    expect(position.getX(EAR_START)).toBeCloseTo(position.getX(ring) - 0.1 * 0.33)
    expect(position.getX(BACK_START)).toBeCloseTo(position.getX(ring) - 0.1)
    expect(position.getZ(BACK_START)).toBeCloseTo(position.getZ(ring))
  })

  it('collapses the shell, but not the face, when no head rotation is available', async () => {
    const occluder = await makeOccluder({ shellDepthRatio: 0.5 })
    const points = makeFaceWorldPoints()
    occluder.updateFromFaceMesh(points, {}, 1, null, null)

    const position = occluder.occluderMesh.geometry.attributes.position
    for (let v = EXTRUDED_START; v <= CAP; v += 1) {
      expect(position.getX(v)).toBeCloseTo(position.getX(0))
      expect(position.getZ(v)).toBeCloseTo(position.getZ(0))
    }
    // The face surface must keep occluding even with no shell.
    const ring = FACE_OVAL_RING[0]
    expect(position.getX(ring)).toBeCloseTo(points[ring].x)
  })
})
