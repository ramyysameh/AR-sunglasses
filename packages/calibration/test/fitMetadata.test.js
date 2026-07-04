import { describe, it, expect } from 'vitest'
import { createFitMetadata } from '../src/fitMetadata.js'

const base = {
  frameWidthMeters: 0.138,
  bridgeAnchor: { x: 0, y: 0, z: 0.01 },
  leftHinge: { x: -0.069, y: 0, z: -0.01 },
  rightHinge: { x: 0.069, y: 0, z: -0.01 },
  frontFramePlaneZ: 0.02,
  lensCenterOffset: { x: 0, y: 0, z: 0 },
  scaleLimits: { min: 0.85, max: 1.15 },
  provenance: { source: 'tagged', confidence: null },
}

describe('createFitMetadata', () => {
  it('stamps the version and returns the full record', () => {
    const record = createFitMetadata(base)
    expect(record.version).toBe('eyewear-v1')
    expect(record.frameWidthMeters).toBe(0.138)
    expect(record.rightHinge).toEqual({ x: 0.069, y: 0, z: -0.01 })
  })

  it('throws listing every missing required field', () => {
    expect(() => createFitMetadata({ frameWidthMeters: 0.138 })).toThrowError(/bridgeAnchor/)
  })

  it('throws a clear error when called with no/invalid argument', () => {
    expect(() => createFitMetadata()).toThrowError(/fields object/)
    expect(() => createFitMetadata(null)).toThrowError(/fields object/)
  })
})
