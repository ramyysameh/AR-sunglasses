import { describe, it, expect } from 'vitest'
import { castDistance, halfWidthAt, toWorldPositions } from '../../src/occlusion/headWidth.js'

/**
 * A truncated pyramid standing on its base: half-width 0.060 at the bottom,
 * 0.090 at the top, 0.100 tall, centred on the origin, extruded 0.2 in z.
 *
 * Deliberately a SLOPE, so "half-width at a height" has a right answer that a
 * vertex-based measurement cannot give between the two rings.
 */
function frustum() {
  const bottom = 0.060, top = 0.090, y0 = -0.05, y1 = 0.05, z0 = -0.1, z1 = 0.1
  const v = [
    [-bottom, y0, z0], [bottom, y0, z0], [-top, y1, z0], [top, y1, z0],
    [-bottom, y0, z1], [bottom, y0, z1], [-top, y1, z1], [top, y1, z1],
  ]
  const positions = new Float64Array(v.flat())
  const indices = [
    0, 2, 4, 4, 2, 6,   // left wall
    1, 5, 3, 5, 7, 3,   // right wall
    0, 4, 1, 1, 4, 5,   // bottom
    2, 3, 6, 6, 3, 7,   // top
    0, 1, 2, 1, 3, 2,   // front cap
    4, 6, 5, 5, 6, 7,   // back cap
  ]
  return { positions, indices }
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const X = [1, 0, 0]
const Y = [0, 1, 0]

describe('castDistance', () => {
  it('returns the distance to the nearest face along the ray', () => {
    const { positions, indices } = frustum()
    const world = toWorldPositions(positions, IDENTITY)
    expect(castDistance(world, indices, [0, 0, 0], X)).toBeCloseTo(0.075, 4)
  })

  it('returns Infinity when the ray leaves without hitting anything', () => {
    const { positions, indices } = frustum()
    const world = toWorldPositions(positions, IDENTITY)
    expect(castDistance(world, indices, [0, 0.5, 0], X)).toBe(Infinity)
  })
})

describe('halfWidthAt', () => {
  it('reads the true half-width at a height, not the nearest vertex ring', () => {
    // THE regression test. At mid-height the frustum is 0.075 wide; the nearest
    // vertices are 0.060 and 0.090, so a vertex-based measure cannot land here.
    const { positions, indices } = frustum()
    const world = toWorldPositions(positions, IDENTITY)
    expect(halfWidthAt(world, indices, [0, 0, 0], X, Y, 0)).toBeCloseTo(0.075, 4)
  })

  it('is continuous in height, with no step at a vertex ring', () => {
    // The bug this replaces: sampling the shell every 9 mm returned
    // 80.2, 75.0, 80.3, 73.8, 80.6, 70.9 mm on a head that does not change
    // shape that way -- the slab was catching a ring or falling between two.
    const { positions, indices } = frustum()
    const world = toWorldPositions(positions, IDENTITY)
    let previous = null
    let biggestStep = 0
    for (let h = -0.045; h <= 0.045; h += 0.005) {
      const w = halfWidthAt(world, indices, [0, 0, 0], X, Y, h)
      if (previous != null) biggestStep = Math.max(biggestStep, Math.abs(w - previous))
      previous = w
    }
    // A 0.005 rise on a slope of 0.3 moves the wall 0.0015. Anything much
    // larger means the measurement is quantised again.
    expect(biggestStep).toBeLessThan(0.002)
  })

  it('averages both sides, so an off-centre origin does not bias it', () => {
    const { positions, indices } = frustum()
    const world = toWorldPositions(positions, IDENTITY)
    const centred = halfWidthAt(world, indices, [0, 0, 0], X, Y, 0)
    const offset = halfWidthAt(world, indices, [0.01, 0, 0], X, Y, 0)
    expect(offset).toBeCloseTo(centred, 6)
  })

  it('returns null when a side misses, rather than a half-measurement', () => {
    const { positions, indices } = frustum()
    const world = toWorldPositions(positions, IDENTITY)
    expect(halfWidthAt(world, indices, [0, 0, 0], X, Y, 0.2)).toBeNull()
  })

  it('works on an axis that is not world-aligned', () => {
    // The head is never square to the world, and a measurement along world X
    // would silently read a diagonal section as the head turns.
    const { positions, indices } = frustum()
    const angle = 0.4
    const matrix = [
      Math.cos(angle), 0, -Math.sin(angle), 0,
      0, 1, 0, 0,
      Math.sin(angle), 0, Math.cos(angle), 0,
      0, 0, 0, 1,
    ]
    const world = toWorldPositions(positions, matrix)
    // Local +X maps to world (cos, 0, -sin) under this column-major matrix.
    const lateral = [Math.cos(angle), 0, -Math.sin(angle)]
    expect(halfWidthAt(world, indices, [0, 0, 0], lateral, Y, 0)).toBeCloseTo(0.075, 4)
  })
})

describe('toWorldPositions', () => {
  it('reuses the caller\'s buffer, so a per-frame call does not allocate', () => {
    const { positions } = frustum()
    const buffer = new Float64Array(positions.length)
    expect(toWorldPositions(positions, IDENTITY, buffer)).toBe(buffer)
  })
})
