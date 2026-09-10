import { describe, it, expect } from 'vitest'
import { buildFramePositions, isInFrontBand, FRAME_DEFAULTS } from './buildFrame.js'
import { computeBounds } from '../../src/geometry.js'

describe('buildFramePositions', () => {
  it('produces a dense front band and sparse temples with known bounds', () => {
    const pos = buildFramePositions()
    const { min, max } = computeBounds(pos)

    expect(pos.length / 3).toBeGreaterThan(2000)
    expect(max.z).toBeCloseTo(0, 6)
    expect(min.z).toBeCloseTo(-FRAME_DEFAULTS.templeLength, 6)
    expect(max.x).toBeCloseTo(FRAME_DEFAULTS.frameWidth / 2, 6)
    expect(max.y).toBeCloseTo(0, 6)
    expect(min.y).toBeCloseTo(-FRAME_DEFAULTS.frontHeight, 6)
  })

  it('is far denser in the front band than behind it', () => {
    const pos = buildFramePositions()
    let front = 0
    let behind = 0
    for (let i = 0; i < pos.length; i += 3) {
      if (isInFrontBand(pos[i + 2])) front += 1
      else behind += 1
    }
    expect(front / behind).toBeGreaterThan(10)
  })

  it('has a bridge bar column whose vertical midpoint is known', () => {
    const pos = buildFramePositions()
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < pos.length; i += 3) {
      if (Math.abs(pos[i]) <= FRAME_DEFAULTS.bridgeHalfWidth && isInFrontBand(pos[i + 2])) {
        lo = Math.min(lo, pos[i + 1])
        hi = Math.max(hi, pos[i + 1])
      }
    }
    expect(hi).toBeCloseTo(-FRAME_DEFAULTS.bridgeBarTop, 6)
    expect(lo).toBeCloseTo(-FRAME_DEFAULTS.bridgeBarBottom, 6)
  })
})
