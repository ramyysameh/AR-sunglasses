import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  EAR_GAP_MAX_PAST_RATIO,
  EAR_GAP_MAX_SHORT_RATIO,
  JUDGED_ABOVE_YAW,
  MAX_ARM_HOLE_PX,
  evaluate,
  headFrame,
} from '../../src/debug/occlusionProbe.js'

/**
 * earGapRatio: where the arm's drawn end sits relative to the EAR PLANE, along
 * the head's fore-aft axis, as a fraction of the tragion-to-tragion span.
 *   > 0  the arm stops SHORT of the ear -- the occluder is eating it
 *   < 0  the arm carries on PAST the ear -- the tip is not being hidden
 * Measured in the head's own frame, so pushing the arm sideways cannot move it.
 */
const row = (yaw, earGapRatio, extra = {}) => ({ yaw, earGapRatio, hiddenPct: 20, ...extra })

describe('occlusion pass/fail criterion', () => {
  it('passes when the arm ends at the ear on every turned pose', () => {
    const result = evaluate([row(-45, -0.08), row(-30, 0.02), row(0, 0.4), row(30, -0.03), row(45, 0.04)])
    expect(result.pass).toBe(true)
    expect(result.failed).toBe(0)
  })

  it('fails an arm that dies short of the ear', () => {
    // The defect the previous criterion scored as a PERFECT result: an over-wide
    // shell swallowed the arm from the cheekbone back, and because that maximises
    // "how much was trimmed" it read as 4/4 with 92 px of trim.
    const result = evaluate([row(-45, 0.6), row(30, 0.48), row(45, 0.55)])
    expect(result.pass).toBe(false)
    expect(result.failed).toBe(3)
    expect(result.failingYaws).toEqual([-45, 30, 45])
  })

  it('fails an arm that runs far past the ear, which is the tip never hiding', () => {
    const result = evaluate([row(-45, -1.2), row(45, -1.4)])
    expect(result.pass).toBe(false)
    expect(result.failed).toBe(2)
  })

  it('ignores head-on poses, where the hinge sets the rear extent, not the tip', () => {
    const result = evaluate([row(0, 0.8), row(45, 0)])
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
    expect(EAR_GAP_MAX_PAST_RATIO).toBeGreaterThan(EAR_GAP_MAX_SHORT_RATIO)
    expect(evaluate([row(JUDGED_ABOVE_YAW, EAR_GAP_MAX_SHORT_RATIO)]).pass).toBe(true)
    expect(evaluate([row(JUDGED_ABOVE_YAW, EAR_GAP_MAX_SHORT_RATIO + 0.001)]).pass).toBe(false)
    expect(evaluate([row(JUDGED_ABOVE_YAW, -EAR_GAP_MAX_PAST_RATIO)]).pass).toBe(true)
    expect(evaluate([row(JUDGED_ABOVE_YAW, -EAR_GAP_MAX_PAST_RATIO - 0.001)]).pass).toBe(false)
    expect(evaluate([row(JUDGED_ABOVE_YAW - 1, 9.99)]).judged).toBe(0)
  })

  it('cannot be satisfied by hiding pixels anywhere else on the arm', () => {
    // hiddenPct is reported but never gates: shaving the middle of the arm while
    // leaving the end exactly where it was is not occlusion working.
    const result = evaluate([row(45, 0.55, { hiddenPct: 90 })])
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
      row(45, -0.04),
    ])
    expect(result.judged).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.pass).toBe(true)
  })

  it('treats a row with no ear reference as unmeasured, not as a pass', () => {
    // earGapRatio is null when the head frame could not be built.
    const result = evaluate([{ yaw: 45, earGapRatio: null, rearTrimPx: 90 }])
    expect(result.judged).toBe(0)
    expect(result.pass).toBe(false)
  })
})

describe('arm continuity', () => {
  const hole = (yaw, armHolePx) => ({ yaw, earGapRatio: -0.2, hiddenPct: 40, armHolePx })

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
    expect(evaluate([{ yaw: 45, earGapRatio: 0.6, armHolePx: 0 }]).pass).toBe(false)
  })

  it('does not require armHolePx, so older rows still evaluate', () => {
    expect(evaluate([{ yaw: 45, earGapRatio: -0.2 }]).pass).toBe(true)
  })
})

describe('the stand-off bias the screen-space metric had', () => {
  it('ignores earGapPx entirely, however flattering it is', () => {
    // The pair that motivated the rewrite, measured on GRIPZ at 38 degrees:
    // the arm lying against the head read +21 px ("short") while the one
    // standing 20 px proud read -47 px ("at the ear"), because stand-off
    // projects backwards at a turned pose. Judging the head-frame number, the
    // hugging arm passes and the floating one is not rescued by its px score.
    expect(evaluate([{ yaw: 38, earGapRatio: 0.02, earGapPx: 21, armHolePx: 0 }]).pass).toBe(true)
    expect(evaluate([{ yaw: 38, earGapRatio: 0.4, earGapPx: -47, armHolePx: 0 }]).pass).toBe(false)
  })

  it("reports the frame's own reach, so a short temple is not read as occlusion", () => {
    // With the occluder off the closed GRIPZ arm still ends well short of the
    // ear on this head. That is the model, not the shell, and chasing it with
    // occluder changes is how the splay ended up pinned at its cap.
    const result = evaluate([{ yaw: 38, earGapRatio: 0.3, reachRatio: 0.22, armHolePx: 0 }])
    expect(result.pass).toBe(false)
    expect(result.reaches).toEqual([0.22])
  })
})

describe('headFrame', () => {
  // A head facing +Z, ears on X. The outer canthi sit just above the ear line
  // and well forward; the nose tip is placed 50 mm BELOW it, as a real one is --
  // that offset is what broke the first version of this frame.
  const build = ({ nose = [0, -0.05, 0.09], eyeA = [-0.045, 0.008, 0.06], eyeB = [0.045, 0.008, 0.06] } = {}) =>
    headFrame(
      new THREE.Vector3(-0.09, 0, 0),
      new THREE.Vector3(0.09, 0, 0),
      new THREE.Vector3(...eyeA),
      new THREE.Vector3(...eyeB),
      new THREE.Vector3(...nose),
    )

  it('puts the origin on the ear plane and measures the span across it', () => {
    const f = build()
    expect(f.origin.toArray()).toEqual([0, 0, 0])
    expect(f.span).toBeCloseTo(0.18, 6)
  })

  it('points forward out of the face, not down at the nose', () => {
    // The nose is 50 mm below the ear line. An axis aimed at it tilts ~30
    // degrees down; this one must stay within a couple of degrees of level.
    const f = build()
    expect(f.forward.z).toBeGreaterThan(0.99)
    expect(Math.abs(f.forward.y)).toBeLessThan(0.14)
  })

  it('gives a depth that barely moves when only HEIGHT changes', () => {
    // The property the whole metric rests on. With the old nose-aimed axis a
    // temple riding 50 mm above the ear plane picked up ~25 mm of spurious
    // depth -- 0.14 of a span, more than the entire short/past tolerance -- and
    // so read as reaching past the ear on every model.
    const f = build()
    const depth = (p) => p.clone().sub(f.origin).dot(f.forward)
    const low = new THREE.Vector3(0.08, 0, -0.01)
    const high = new THREE.Vector3(0.08, 0.05, -0.01)
    expect(Math.abs(depth(high) - depth(low))).toBeLessThan(0.007)
  })

  it('is unmoved by pushing a sample sideways, which is why it replaced screen X', () => {
    const f = build()
    const depth = (p) => p.clone().sub(f.origin).dot(f.forward)
    const near = new THREE.Vector3(0.07, 0.03, -0.02)
    const wide = new THREE.Vector3(0.13, 0.03, -0.02)
    expect(depth(wide)).toBeCloseTo(depth(near), 9)
  })

  it('uses the nose only for sign, so a nose far off-centre cannot tilt it', () => {
    const straight = build()
    const skewed = build({ nose: [0.04, -0.12, 0.06] })
    expect(skewed.forward.angleTo(straight.forward)).toBeCloseTo(0, 9)
  })

  it('pairs each eye with its nearer ear, so the landmark order need not be assumed', () => {
    const a = build()
    const b = build({ eyeA: [0.045, 0.008, 0.06], eyeB: [-0.045, 0.008, 0.06] })
    expect(b.forward.angleTo(a.forward)).toBeCloseTo(0, 9)
  })

  it('returns null rather than a garbage frame when the landmarks are degenerate', () => {
    const o = new THREE.Vector3()
    expect(headFrame(o, o.clone(), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1))).toBeNull()
    // eyes coincident with the ears: nothing left after the lateral part is out
    expect(headFrame(
      new THREE.Vector3(-0.09, 0, 0), new THREE.Vector3(0.09, 0, 0),
      new THREE.Vector3(-0.09, 0, 0), new THREE.Vector3(0.09, 0, 0),
      new THREE.Vector3(0, 0, 1),
    )).toBeNull()
  })
})
