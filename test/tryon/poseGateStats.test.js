import { describe, expect, it } from 'vitest'
import {
  AXIS_SIGNS,
  axisSanity,
  checkThresholds,
  computeBias,
  formatComparison,
  scorePoseRun,
  wrapDeg,
} from '../../harness/poseGateStats.js'

/** A synthetic run: engine angles = sign * truth + bias + error. */
function makeRows({ yawBias = 0, pitchBias = 5, yawError = () => 0, anchorDv = () => 0, tracked = () => true } = {}) {
  const rows = []
  const segs = [['hold', 120], ['yaw', 60], ['still', 20]]
  let frame = 0
  for (const [seg, n] of segs) {
    for (let i = 0; i < n; i += 1, frame += 1) {
      const truth = { yaw: seg === 'yaw' ? 45 * Math.sin((2 * Math.PI * i) / n) : 0, pitch: 0, roll: 0, dist: 1 }
      const yaw = AXIS_SIGNS.yaw * truth.yaw + yawBias + yawError(frame, truth)
      const angles = { yaw, pitch: pitchBias, roll: 0 }
      rows.push({
        frame, seg, truth,
        tracked: tracked(frame),
        source: 'mediapipe',
        raw: angles,
        shown: angles,
        rawAnchor: { u: 100, v: 200 + anchorDv(frame, truth) },
        shownAnchor: { u: 100, v: 200 + anchorDv(frame, truth) },
        truthAnchor: { u: 100, v: 200 },
        mmPerPx: 0.5,
      })
    }
  }
  return rows
}

describe('pose gate scoring', () => {
  it('removes the seated bias, so a constant offset is not tracking error', () => {
    const rows = makeRows({ yawBias: 3, pitchBias: 7, anchorDv: () => 4 })
    const bias = computeBias(rows)
    expect(bias.raw.yaw).toBeCloseTo(3)
    expect(bias.raw.pitch).toBeCloseTo(7)
    expect(bias.shown.dv).toBeCloseTo(4)
    const score = scorePoseRun(rows)
    expect(score.segments.yaw.shown.yaw.mae).toBeCloseTo(0)
    expect(score.segments.yaw.shown.drift.mae).toBeCloseTo(0)
  })

  it('reports per-segment error and drift in mm, with the riding-up direction signed', () => {
    const rows = makeRows({
      yawError: (f, t) => (Math.abs(t.yaw) > 30 ? 4 : 0),
      anchorDv: (f, t) => -Math.abs(t.yaw) / 4.5, // up by 10 px (5 mm) at 45 degrees
    })
    const score = scorePoseRun(rows)
    expect(score.segments.yaw.shown.yaw.max).toBeCloseTo(4)
    expect(score.segments.yaw.shown.drift.max).toBeCloseTo(5, 0)
    expect(score.segments.yaw.shown.meanDyMm).toBeLessThan(0)
    expect(score.segments.hold.shown.yaw.mae).toBeCloseTo(0)
  })

  it('counts hidden frames against tracking coverage and leaves them out of the errors', () => {
    const rows = makeRows({ tracked: (f) => !(f >= 130 && f < 145) })
    const score = scorePoseRun(rows)
    expect(score.segments.yaw.trackedPct).toBeCloseTo(75)
    expect(score.segments.yaw.shown.yaw.n).toBe(45)
  })

  it('catches a wrong mirror convention through the axis sanity check', () => {
    const rows = makeRows()
    expect(axisSanity(rows).yaw).toBeGreaterThan(0.99)
    expect(axisSanity(rows, { ...AXIS_SIGNS, yaw: 1 }).yaw).toBeLessThan(-0.99)
  })

  it('wraps angle differences across the +/-180 seam', () => {
    expect(wrapDeg(350)).toBe(-10)
    expect(wrapDeg(-190)).toBe(170)
  })
})

describe('pose gate limits', () => {
  const score = scorePoseRun(makeRows({ yawError: (f, t) => (Math.abs(t.yaw) > 30 ? 4 : 0) }))

  it('passes within limits and names each violation outside them', () => {
    expect(checkThresholds(score, { segments: { yaw: { 'yaw.max': 5, '/trackedPct': { min: 99 } } } })).toEqual([])
    const failures = checkThresholds(score, { segments: { yaw: { 'yaw.max': 3 }, pitch: { 'yaw.mae': 1 } } })
    expect(failures.map((f) => `${f.seg}:${f.key}:${f.reason}`)).toEqual(['yaw:yaw.max:above max', 'pitch:*:segment missing from run'])
  })

  it('renders a comparison table with one row per segment', () => {
    const table = formatComparison({ before: score, after: score })
    expect(table.split('\n')).toHaveLength(2 + 3)
    expect(table).toContain('| yaw |')
  })
})
