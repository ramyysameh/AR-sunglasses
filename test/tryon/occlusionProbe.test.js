import { describe, it, expect } from 'vitest'
import { evaluate, MIN_REAR_TRIM_PX, JUDGED_ABOVE_YAW } from '../../src/debug/occlusionProbe.js'

const row = (yaw, rearTrimPx, hiddenPct = 20) => ({ yaw, rearTrimPx, hiddenPct })

describe('occlusion pass/fail criterion', () => {
  it('passes when every turned pose shortens the arm', () => {
    const result = evaluate([row(-45, 14), row(-30, 9), row(0, 0), row(30, 8), row(45, 12)])
    expect(result.pass).toBe(true)
    expect(result.failed).toBe(0)
  })

  it('ignores head-on poses, where the hinge sets the rear extent, not the tip', () => {
    // 0 trim at 0 degrees is expected and must not fail the run.
    const result = evaluate([row(0, 0), row(45, 12)])
    expect(result.judged).toBe(1)
    expect(result.pass).toBe(true)
  })

  it('fails the exact bug this was built to catch: pixels hidden, arm not shortened', () => {
    // The open-strip occluder scored 6-24% hidden at every angle while never
    // trimming the rear -- it shaved the middle of the arm and left the tip.
    const result = evaluate([row(-45, 0, 24), row(30, 0, 16), row(45, 0, 22)])
    expect(result.pass).toBe(false)
    expect(result.failed).toBe(3)
    expect(result.failingYaws).toEqual([-45, 30, 45])
  })

  it('does not pass a sweep that never reached a judged angle', () => {
    // An all-frontal sweep proves nothing; treating it as a pass would let a
    // broken occluder through on an empty result.
    expect(evaluate([row(0, 0), row(5, 0)]).pass).toBe(false)
    expect(evaluate([]).pass).toBe(false)
  })

  it('judges by the documented thresholds', () => {
    expect(evaluate([row(JUDGED_ABOVE_YAW, MIN_REAR_TRIM_PX)]).pass).toBe(true)
    expect(evaluate([row(JUDGED_ABOVE_YAW, MIN_REAR_TRIM_PX - 1)]).pass).toBe(false)
    expect(evaluate([row(JUDGED_ABOVE_YAW - 1, 0)]).judged).toBe(0)
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
      row(45, 12),
    ])
    expect(result.judged).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.pass).toBe(true)
  })
})
