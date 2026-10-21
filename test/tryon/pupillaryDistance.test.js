import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PD_MM,
  IRIS_DIAMETER_MM,
  PD_MIN_SAMPLES,
  PupillaryDistanceEstimator,
  irisPdSample,
  trueSizeScale,
} from '../../src/fit/pupillaryDistance.js'

const W = 1280
const H = 720

/**
 * 478 normalised landmarks for a frontal face whose pupils are pdPx apart, with
 * irises irisPx across (left, right), eye openness `open` (lid gap / eye width).
 */
function face({ pdPx = 160, irisPx = [30, 30], open = 0.33, cx = 640, cy = 360 } = {}) {
  const lms = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }))
  const put = (i, x, y) => { lms[i] = { x: x / W, y: y / H, z: 0 } }
  const eyes = [
    { c: 468, ring: [469, 470, 471, 472], corners: [33, 133], lids: [159, 145], x: cx - pdPx / 2, iris: irisPx[0] },
    { c: 473, ring: [474, 475, 476, 477], corners: [362, 263], lids: [386, 374], x: cx + pdPx / 2, iris: irisPx[1] },
  ]
  for (const e of eyes) {
    const r = e.iris / 2
    put(e.c, e.x, cy)
    put(e.ring[0], e.x + r, cy); put(e.ring[1], e.x, cy - r)
    put(e.ring[2], e.x - r, cy); put(e.ring[3], e.x, cy + r)
    const half = 30 // eye 60 px wide
    put(e.corners[0], e.x - half, cy); put(e.corners[1], e.x + half, cy)
    put(e.lids[0], e.x, cy - open * 30); put(e.lids[1], e.x, cy + open * 30)
  }
  return lms
}

describe('irisPdSample', () => {
  it('reads PD as pupil spacing in iris diameters times 11.7 mm', () => {
    // 160 px apart, 30 px irises: 160/30 * 11.7 = 62.4 mm
    expect(irisPdSample(face(), W, H).pdMm).toBeCloseTo((160 / 30) * IRIS_DIAMETER_MM, 6)
  })

  it('does not depend on how far the face is: the ratio cancels distance', () => {
    const near = irisPdSample(face({ pdPx: 240, irisPx: [45, 45] }), W, H).pdMm
    const far = irisPdSample(face({ pdPx: 120, irisPx: [22.5, 22.5] }), W, H).pdMm
    expect(near).toBeCloseTo(far, 6)
  })

  it('refuses a turned or pitched head', () => {
    expect(irisPdSample(face(), W, H, { yawDeg: 25 }).rejected).toBe('turned')
    expect(irisPdSample(face(), W, H, { pitchDeg: 30 }).rejected).toBe('pitched')
  })

  it('refuses a blink, a tiny face, mismatched irises and impossible readings', () => {
    expect(irisPdSample(face({ open: 0.05 }), W, H).rejected).toBe('eye-closing')
    expect(irisPdSample(face({ pdPx: 40, irisPx: [7, 7] }), W, H).rejected).toBe('iris-too-small')
    expect(irisPdSample(face({ irisPx: [30, 22] }), W, H).rejected).toBe('iris-mismatch')
    expect(irisPdSample(face({ pdPx: 300 }), W, H).rejected).toBe('implausible')
  })

  it('needs the iris landmarks', () => {
    expect(irisPdSample(face().slice(0, 468), W, H).rejected).toBe('no-iris-landmarks')
  })
})

describe('PupillaryDistanceEstimator', () => {
  it('uses the population mean until enough samples agree', () => {
    const est = new PupillaryDistanceEstimator()
    for (let i = 0; i < PD_MIN_SAMPLES - 1; i += 1) est.add({ pdMm: 58 })
    expect(est.estimate()).toMatchObject({ pdMm: DEFAULT_PD_MM, converged: false })
    est.add({ pdMm: 58 })
    expect(est.estimate()).toMatchObject({ pdMm: 58, converged: true })
  })

  it('takes the median, so a few wild readings do not move it', () => {
    const est = new PupillaryDistanceEstimator()
    for (let i = 0; i < 40; i += 1) est.add({ pdMm: 60 + (i % 3) * 0.5 })
    est.add({ pdMm: 75 }); est.add({ pdMm: 53 })
    expect(est.estimate().pdMm).toBeCloseTo(60.5, 1)
  })

  it('does not converge on readings that disagree', () => {
    const est = new PupillaryDistanceEstimator()
    for (let i = 0; i < 60; i += 1) est.add({ pdMm: i % 2 ? 56 : 70 })
    expect(est.estimate().converged).toBe(false)
  })

  it('ignores rejected samples', () => {
    const est = new PupillaryDistanceEstimator()
    est.add({ rejected: 'turned' })
    expect(est.estimate().samples).toBe(0)
  })
})

describe('FaceFitSolver true size switch', () => {
  it('measures PD by default and not with trueSize: false (?truesize=0)', async () => {
    const { FaceFitSolver } = await import('../../src/fit/FaceFitSolver.js')
    expect(new FaceFitSolver()._pd).toBeInstanceOf(PupillaryDistanceEstimator)
    expect(new FaceFitSolver({ trueSize: false })._pd).toBeNull()
  })

  it('learns the PD from frames seen before the face scan finishes', async () => {
    const THREE = await import('three')
    const { FaceFitSolver } = await import('../../src/fit/FaceFitSolver.js')
    const solver = new FaceFitSolver()
    const camera = { _videoW: W, _videoH: H }
    const frontal = new THREE.Matrix4()
    for (let i = 0; i < PD_MIN_SAMPLES; i += 1) solver.observeFace({ landmarks: face(), faceMatrix: frontal, camera })
    expect(solver._pd.estimate()).toMatchObject({ converged: true })
    expect(solver._pd.estimate().pdMm).toBeCloseTo((160 / 30) * IRIS_DIAMETER_MM, 6)
  })
})

describe('trueSizeScale', () => {
  it('draws the frame at its physical width relative to the eyes', () => {
    // Eyes 0.081 scene units apart (the mock head as placed); wearer 62.7 mm.
    const scale = trueSizeScale(0.081, 62.7)
    const frameWidthM = 0.148
    // At the eyes' depth, frame width / eye spacing = (frame * scale) / 0.081.
    expect((frameWidthM * scale) / 0.081).toBeCloseTo(148 / 62.7, 6)
  })
})
