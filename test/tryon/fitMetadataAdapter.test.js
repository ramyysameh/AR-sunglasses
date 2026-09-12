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
