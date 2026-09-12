import { describe, it, expect } from 'vitest'
import {
  EAR_GAP_MAX_PAST_PX,
  EAR_GAP_MAX_SHORT_PX,
  JUDGED_ABOVE_YAW,
  MAX_ARM_HOLE_PX,
  evaluate,
} from '../../src/debug/occlusionProbe.js'

/**
 * earGapPx: where the arm's visible end sits relative to the ear.
 *   > 0  the arm stops SHORT of the ear -- the occluder is eating it
 *   < 0  the arm carries on PAST the ear -- the tip is not being hidden
 */
const row = (yaw, earGapPx, extra = {}) => ({ yaw, earGapPx, hiddenPct: 20, ...extra })

describe('occlusion pass/fail criterion', () => {
  it('passes when the arm ends at the ear on every turned pose', () => {
    const result = evaluate([row(-45, -8), row(-30, 2), row(0, 40), row(30, -3), row(45, 5)])
    expect(result.pass).toBe(true)
    expect(result.failed).toBe(0)
  })

  it('fails an arm that dies short of the ear', () => {
    // The defect the previous criterion scored as a PERFECT result: an over-wide
    // shell swallowed the arm from the cheekbone back, and because that maximises
    // "how much was trimmed" it read as 4/4 with 92 px of trim.
    const result = evaluate([row(-45, 60), row(30, 48), row(45, 55)])
    expect(result.pass).toBe(false)
    expect(result.failed).toBe(3)
    expect(result.failingYaws).toEqual([-45, 30, 45])
  })

  it('fails an arm that runs far past the ear, which is the tip never hiding', () => {
    const result = evaluate([row(-45, -120), row(45, -140)])
    expect(result.pass).toBe(false)
    expect(result.failed).toBe(2)
  })

  it('ignores head-on poses, where the hinge sets the rear extent, not the tip', () => {
    const result = evaluate([row(0, 80), row(45, 0)])
    expect(result.judged).toBe(1)
    expect(result.pass).toBe(true)
  })

  it('does not pass a sweep that never reached a judged angle', () => {
    // An all-frontal sweep proves nothing; treating it as a pass would let a
    // broken occluder through on an empty result.
    expect(evaluate([row(0, 0), row(5, 0)]).pass).toBe(false)
    expect(evaluate([]).pass).toBe(false)
  })

  it('judges by the documented thresholds, and is deliberately asymmetric', () => {
    // Short of the ear is the visible defect, so it is held tighter than past it.
    expect(EAR_GAP_MAX_PAST_PX).toBeGreaterThan(EAR_GAP_MAX_SHORT_PX)
    expect(evaluate([row(JUDGED_ABOVE_YAW, EAR_GAP_MAX_SHORT_PX)]).pass).toBe(true)
    expect(evaluate([row(JUDGED_ABOVE_YAW, EAR_GAP_MAX_SHORT_PX + 1)]).pass).toBe(false)
    expect(evaluate([row(JUDGED_ABOVE_YAW, -EAR_GAP_MAX_PAST_PX)]).pass).toBe(true)
    expect(evaluate([row(JUDGED_ABOVE_YAW, -EAR_GAP_MAX_PAST_PX - 1)]).pass).toBe(false)
    expect(evaluate([row(JUDGED_ABOVE_YAW - 1, 999)]).judged).toBe(0)
  })

  it('cannot be satisfied by hiding pixels anywhere else on the arm', () => {
    // hiddenPct is reported but never gates: shaving the middle of the arm while
    // leaving the end exactly where it was is not occlusion working.
    const result = evaluate([row(45, 55, { hiddenPct: 90 })])
    expect(result.pass).toBe(false)
  })
})

describe('skipped measurements', () => {
  it('never counts an unmeasured pose as a pass', () => {
    // A sweep where tracking dropped produces rows with no numbers at all.
    // Treating those as passes is the failure mode this guard exists for.
    const result = evaluate([
      { skipped: 'glasses hidden (tracking lost or calibrating)' },
      { skipped: 'temples drew no pixels even with the occluder off' },
    ])
    expect(result.pass).toBe(false)
    expect(result.skipped).toBe(2)
    expect(result.judged).toBe(0)
  })

  it('scores only the poses it actually measured', () => {
    const result = evaluate([
      { skipped: 'glasses hidden (tracking lost or calibrating)' },
      row(45, -4),
    ])
    expect(result.judged).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.pass).toBe(true)
  })

  it('treats a row with no ear reference as unmeasured, not as a pass', () => {
    // earGapPx is null when the ear landmarks could not be projected.
    const result = evaluate([{ yaw: 45, earGapPx: null, rearTrimPx: 90 }])
    expect(result.judged).toBe(0)
    expect(result.pass).toBe(false)
  })
})

describe('arm continuity', () => {
  const hole = (yaw, armHolePx) => ({ yaw, earGapPx: -20, hiddenPct: 40, armHolePx })

  it('fails an arm with a bite taken out of its middle', () => {
    // The end can land perfectly while the arm is in two pieces. Judging only
    // the end passes this, which is exactly how it reached a user.
    const result = evaluate([hole(-45, 34), hole(45, 41)])
    expect(result.pass).toBe(false)
    expect(result.failed).toBe(2)
  })

  it('tolerates the small gaps an arm legitimately has', () => {
    // Antialiasing, and the seams between an arm's own parts.
    expect(evaluate([hole(45, MAX_ARM_HOLE_PX)]).pass).toBe(true)
    expect(evaluate([hole(45, MAX_ARM_HOLE_PX + 1)]).pass).toBe(false)
  })

  it('still judges the end even when the arm is whole', () => {
    expect(evaluate([{ yaw: 45, earGapPx: 60, armHolePx: 0 }]).pass).toBe(false)
  })

  it('does not require armHolePx, so older rows still evaluate', () => {
    expect(evaluate([{ yaw: 45, earGapPx: -20 }]).pass).toBe(true)
  })
})
