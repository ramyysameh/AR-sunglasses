import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { splitAtPlane } from '../../src/models/templeSplit.js'

/** Cut at z = k, front = the +z side. */
const atZ = (k) => (x, y, z) => z - k

function geometry(triangles, extra = {}) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(triangles.flat(2)), 3))
  for (const [name, { data, itemSize }] of Object.entries(extra)) {
    g.setAttribute(name, new THREE.BufferAttribute(Float32Array.from(data), itemSize))
  }
  return g
}

/** Sum of triangle areas, so a split can be checked for losing or inventing surface. */
function area(g) {
  const p = g.getAttribute('position')
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  let total = 0
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i)
    b.fromBufferAttribute(p, i + 1)
    c.fromBufferAttribute(p, i + 2)
    total += b.sub(a).cross(c.sub(a)).length() / 2
  }
  return total
}

const FRONT = [[0, 0, 1], [1, 0, 1], [0, 1, 1]]
const REAR = [[0, 0, -1], [1, 0, -1], [0, 1, -1]]
/** Straddles z = 0: one vertex behind, two in front. */
const CROSSING = [[0, 0, -1], [2, 0, 1], [0, 2, 1]]

describe('splitAtPlane', () => {
  it('sends a triangle that is wholly on one side to that side, untouched', () => {
    const { front, rear } = splitAtPlane(geometry([FRONT, REAR]), atZ(0))
    expect(front.getAttribute('position').count).toBe(3)
    expect(rear.getAttribute('position').count).toBe(3)
    expect(Array.from(front.getAttribute('position').array)).toEqual(FRONT.flat())
    expect(Array.from(rear.getAttribute('position').array)).toEqual(REAR.flat())
  })

  it('clips a straddling triangle instead of assigning it whole', () => {
    // Assigning by centroid is the simple version and it leaves the seam ragged
    // by a triangle's width, which tears visibly the moment the rear rotates.
    const { front, rear } = splitAtPlane(geometry([CROSSING]), atZ(0))
    expect(rear.getAttribute('position').count).toBe(3)   // the lone corner
    expect(front.getAttribute('position').count).toBe(6)  // the remaining quad
  })

  it('conserves surface area exactly', () => {
    const src = geometry([CROSSING, FRONT, REAR])
    const { front, rear } = splitAtPlane(src, atZ(0))
    expect(area(front) + area(rear)).toBeCloseTo(area(src), 5)
  })

  it('puts the new vertices exactly on the plane, so the pieces meet', () => {
    const { front, rear } = splitAtPlane(geometry([CROSSING]), atZ(0))
    for (const piece of [front, rear]) {
      const p = piece.getAttribute('position')
      const onPlane = []
      for (let i = 0; i < p.count; i += 1) if (Math.abs(p.getZ(i)) < 1e-9) onPlane.push(i)
      expect(onPlane.length).toBeGreaterThan(0)
    }
  })

  it('leaves no gap between the pieces along the cut', () => {
    // Every cut-plane vertex of one piece must be matched by the other, or the
    // arm shows daylight through the joint.
    const { front, rear } = splitAtPlane(geometry([CROSSING]), atZ(0))
    const onPlane = (g) => {
      const p = g.getAttribute('position')
      const out = []
      for (let i = 0; i < p.count; i += 1) {
        if (Math.abs(p.getZ(i)) < 1e-9) out.push(`${p.getX(i).toFixed(6)},${p.getY(i).toFixed(6)}`)
      }
      return new Set(out)
    }
    expect([...onPlane(front)].sort()).toEqual([...onPlane(rear)].sort())
  })

  it('interpolates every attribute, not just position', () => {
    const src = geometry([CROSSING], {
      uv: { data: [0, 0, 1, 0, 0, 1], itemSize: 2 },
      normal: { data: [0, 0, -1, 0, 0, 1, 0, 0, 1], itemSize: 3 },
    })
    const { front } = splitAtPlane(src, atZ(0))
    expect(front.getAttribute('uv')).toBeTruthy()
    expect(front.getAttribute('uv').count).toBe(front.getAttribute('position').count)
    expect(front.getAttribute('normal').count).toBe(front.getAttribute('position').count)
  })

  it('renormalises blended normals, which a linear mix leaves short', () => {
    // Not opposites: a blend of those is the zero vector, which is its own case.
    const src = geometry([CROSSING], { normal: { data: [1, 0, 0, 0, 1, 0, 0, 0, 1], itemSize: 3 } })
    const { front, rear } = splitAtPlane(src, atZ(0))
    for (const piece of [front, rear]) {
      const n = piece.getAttribute('normal')
      for (let i = 0; i < n.count; i += 1) {
        const v = new THREE.Vector3().fromBufferAttribute(n, i)
        expect(v.length()).toBeCloseTo(1, 6)
      }
    }
  })

  it('keeps each triangle wound the way it arrived', () => {
    // A flipped winding renders as a hole once backface culling is on.
    const src = geometry([CROSSING])
    const before = new THREE.Vector3(0, 0, 0)
    const p = src.getAttribute('position')
    const a = new THREE.Vector3().fromBufferAttribute(p, 0)
    const b = new THREE.Vector3().fromBufferAttribute(p, 1)
    const c = new THREE.Vector3().fromBufferAttribute(p, 2)
    before.copy(b.clone().sub(a).cross(c.clone().sub(a)).normalize())

    const { front, rear } = splitAtPlane(src, atZ(0))
    for (const piece of [front, rear]) {
      const q = piece.getAttribute('position')
      for (let i = 0; i < q.count; i += 3) {
        const u = new THREE.Vector3().fromBufferAttribute(q, i)
        const v = new THREE.Vector3().fromBufferAttribute(q, i + 1)
        const w = new THREE.Vector3().fromBufferAttribute(q, i + 2)
        const n = v.sub(u).cross(w.sub(u)).normalize()
        expect(n.dot(before)).toBeGreaterThan(0.99)
      }
    }
  })

  it('leaves a degenerate blend at zero rather than emitting NaN', () => {
    // Exactly opposing normals average to nothing. Normalising that is a divide
    // by zero, and a NaN in a vertex buffer takes the whole mesh off screen.
    const src = geometry([CROSSING], { normal: { data: [0, 0, -1, 0, 0, 1, 0, 0, 1], itemSize: 3 } })
    const { front, rear } = splitAtPlane(src, atZ(0))
    for (const piece of [front, rear]) {
      for (const value of piece.getAttribute('normal').array) expect(Number.isNaN(value)).toBe(false)
    }
  })

  it('ignores a trailing partial triangle instead of reading past the end', () => {
    // A buffer with a vertex count that is not a multiple of 3 used to read
    // undefined off the end, which became NaN and took the whole arm off screen.
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from([...CROSSING.flat(), 0, 0, 5, 0, 0, -5]), 3))
    const { front, rear } = splitAtPlane(g, atZ(0))
    for (const piece of [front, rear]) {
      for (const value of piece.getAttribute('position').array) expect(Number.isNaN(value)).toBe(false)
    }
  })

  it('accepts indexed geometry', () => {
    const g = geometry([CROSSING])
    g.setIndex([0, 1, 2])
    const { front, rear } = splitAtPlane(g, atZ(0))
    expect(front.getAttribute('position').count + rear.getAttribute('position').count).toBe(9)
  })

  it('gives an empty piece rather than failing when nothing is on that side', () => {
    const { front, rear } = splitAtPlane(geometry([FRONT]), atZ(0))
    expect(front.getAttribute('position').count).toBe(3)
    expect(rear.getAttribute('position').count).toBe(0)
  })
})
