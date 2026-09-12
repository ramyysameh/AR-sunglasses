import { describe, it, expect } from 'vitest'
import { toEngineModelConfig } from '../../src/tryon/fitMetadataAdapter.js'

const fit = {
  version: 'eyewear-v1',
  frameWidthMeters: 0.145,
  bridgeAnchor: { x: 0, y: 0, z: 0.02 },
  leftHinge: { x: -0.069, y: -0.024, z: -0.01 },
  rightHinge: { x: 0.069, y: -0.024, z: -0.01 },
  frontFramePlaneZ: 0.02,
  lensCenterOffset: { x: 0, y: 0, z: 0 },
  scaleLimits: { min: 0.85, max: 1.15 },
  provenance: { source: 'tagged', confidence: null },
}

describe('toEngineModelConfig', () => {
  it('maps A1 fit-metadata into the engine model config', () => {
    const cfg = toEngineModelConfig(fit, '/models/abc.glb')
    expect(cfg.modelUrl).toBe('/models/abc.glb')
    expect(cfg.frameWidthMeters).toBe(0.145)
    expect(cfg.bridgePivot).toEqual({ x: 0, y: 0, z: 0.02 })
    expect(cfg.leftHingePoint).toEqual({ x: -0.069, y: -0.024, z: -0.01 })
    expect(cfg.scaleLimits).toEqual({ min: 0.85, max: 1.15 })
  })
})

describe('bridgePivot frame', () => {
  const base = {
    frameWidthMeters: 0.146,
    bridgeAnchor: { x: 0, y: 0, z: 0 },
    leftHinge: { x: -0.073, y: 0, z: -0.038 },
    rightHinge: { x: 0.073, y: 0, z: -0.038 },
    frontFramePlaneZ: 0,
    lensCenterOffset: { x: 0, y: 0, z: 0 },
    scaleLimits: { min: 0.6, max: 1.6 },
    modelScale: 1,
    modelBoundsCenter: { x: 0, y: -0.0208, z: -0.078 },
    provenance: { source: 'geometric', confidence: null },
  }

  it('offsets the anchor by the pivot the loader will re-origin to', () => {
    const cfg = toEngineModelConfig(base, '/models/x.glb')
    // Loader pivot is (centerX, centerY, maxZ) -- depthPivot 'frontMaxZ'.
    expect(cfg.bridgePivot.x).toBeCloseTo(0, 6)
    expect(cfg.bridgePivot.y).toBeCloseTo(0.0208, 6)
    expect(cfg.bridgePivot.z).toBeCloseTo(0, 6)
  })

  it('is immune to where the normalizer happened to put the origin', () => {
    // A rigid translation of the whole measurement frame must cancel: the pivot
    // is a difference of two points measured in that same frame.
    const shifted = {
      ...base,
      bridgeAnchor: { x: 0.5, y: 0.5, z: 0.5 },
      frontFramePlaneZ: 0.5,
      modelBoundsCenter: { x: 0.5, y: 0.4792, z: 0.422 },
    }
    expect(toEngineModelConfig(shifted, '/models/x.glb').bridgePivot.y).toBeCloseTo(0.0208, 4)
  })

  it('passes modelScale through', () => {
    expect(toEngineModelConfig({ ...base, modelScale: 0.0483 }, '/x.glb').modelScale)
      .toBeCloseTo(0.0483, 6)
  })

  it('falls back to the raw anchor for rows written before modelBoundsCenter', () => {
    const { modelBoundsCenter, modelScale, ...legacy } = base
    const cfg = toEngineModelConfig({ ...legacy, bridgeAnchor: { x: 0, y: 0.004, z: 0 } }, '/x.glb')
    expect(cfg.bridgePivot).toEqual({ x: 0, y: 0.004, z: 0 })
    expect(cfg.modelScale).toBe(1)
  })
})
