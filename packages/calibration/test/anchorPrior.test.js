import { describe, it, expect } from 'vitest'
import { canonicalAnchors, applyPrior } from '../src/anchorPrior.js'

// Matches the measured band of both reference models: cliff at -11mm,
// half-width 73.1mm, on a 146mm frame.
const band = { frontZMin: -0.011, frontZMax: 0, halfWidth: 0.0731, sharpness: 30 }

describe('canonicalAnchors', () => {
  it('places anatomically plausible anchors from frame width alone', () => {
    const a = canonicalAnchors(0.146, band)
    expect(a.bridge.x).toBe(0)
    expect(a.bridge.y).toBeLessThan(0)
    expect(a.bridge.y).toBeGreaterThan(-0.025)
    expect(a.bridge.z).toBeLessThan(band.frontZMax)
    expect(a.rightHinge.x).toBeGreaterThan(0.05)
    expect(a.rightHinge.x).toBeLessThan(band.halfWidth)
    expect(a.leftHinge.x).toBeCloseTo(-a.rightHinge.x, 6)
  })

  it('lands within 3mm of both hand-placed reference anchors', () => {
    // The prior is the fallback, but it must still be good enough to ship: if
    // it is not, substituting it on an unreadable model does real harm.
    const a = canonicalAnchors(0.146, band)
    const near = (actual, expected) => Math.abs(actual - expected) * 1000
    // Larsson hand: bridge y=-9.6 z=-3.6, hinge x=66.7 y=-9.1 z=-9.9
    // GRIPZ   hand: bridge y=-11.4 z=-3.7, hinge x=65.4 y=-10.6 z=-10.6
    expect(near(a.bridge.y, -0.0096)).toBeLessThan(3)
    expect(near(a.bridge.y, -0.0114)).toBeLessThan(3)
    expect(near(a.bridge.z, -0.0036)).toBeLessThan(3)
    expect(near(a.rightHinge.x, 0.0667)).toBeLessThan(3)
    expect(near(a.rightHinge.x, 0.0654)).toBeLessThan(3)
    expect(near(a.rightHinge.y, -0.0091)).toBeLessThan(3)
    expect(near(a.rightHinge.y, -0.0106)).toBeLessThan(3)
    expect(near(a.rightHinge.z, -0.0099)).toBeLessThan(3)
    expect(near(a.rightHinge.z, -0.0106)).toBeLessThan(3)
  })

  it('scales with frame width', () => {
    const small = canonicalAnchors(0.120, band)
    const large = canonicalAnchors(0.150, band)
    expect(large.bridge.y).toBeLessThan(small.bridge.y)
  })

  it('falls back to half the frame width when the band has no half-width', () => {
    const a = canonicalAnchors(0.146, { ...band, halfWidth: 0 })
    expect(a.rightHinge.x).toBeCloseTo(0.073 * 0.905, 3)
  })
})

describe('applyPrior', () => {
  it('keeps a detected anchor that is close to the prior', () => {
    const prior = { x: 0.066, y: -0.010, z: -0.012 }
    const detected = { x: 0.067, y: -0.011, z: -0.012 }
    const result = applyPrior(detected, prior, 0.146)
    expect(result.source).toBe('detected')
    expect(result.anchor).toBe(detected)
  })

  it('substitutes the prior when the detected anchor is implausible', () => {
    const prior = { x: 0.066, y: -0.010, z: -0.012 }
    const detected = { x: 0.066, y: -0.010, z: -0.090 }
    const result = applyPrior(detected, prior, 0.146)
    expect(result.source).toBe('prior')
    expect(result.anchor).toBe(prior)
  })

  it('substitutes the prior for a non-finite detected anchor', () => {
    const prior = { x: 0.066, y: -0.010, z: -0.012 }
    expect(applyPrior({ x: NaN, y: 0, z: 0 }, prior, 0.146).source).toBe('prior')
  })

  it('substitutes the prior for a null detected anchor', () => {
    const prior = { x: 0.066, y: -0.010, z: -0.012 }
    expect(applyPrior(null, prior, 0.146).source).toBe('prior')
  })
})
