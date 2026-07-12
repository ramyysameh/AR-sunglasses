import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { registerRuntimeGlassesConfig, getGlassesConfig } from '../../src/config/arConfig.js'
import { toEngineModelConfig } from '../../src/tryon/fitMetadataAdapter.js'

const REMOTE_SKU_KEY = '__remote__'

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

describe('registerRuntimeGlassesConfig', () => {
  it('wraps adapter-provided vector fields into THREE.Vector3 instances', () => {
    const engineModelConfig = toEngineModelConfig(fit, '/models/remote.glb')
    const key = registerRuntimeGlassesConfig(REMOTE_SKU_KEY, engineModelConfig)
    const cfg = getGlassesConfig(key)

    expect(cfg.bridgePivot).toBeInstanceOf(THREE.Vector3)
    expect(cfg.lensCenterOffset).toBeInstanceOf(THREE.Vector3)
    expect(typeof cfg.bridgePivot.clone).toBe('function')
    expect(typeof cfg.lensCenterOffset.clone).toBe('function')

    // Values should be preserved through the wrapping.
    expect(cfg.bridgePivot.z).toBeCloseTo(0.02)
    expect(cfg.lensCenterOffset.x).toBe(0)
  })

  it('renders block models with their authored GLB materials (preserveMaterials)', () => {
    const engineModelConfig = toEngineModelConfig(fit, '/models/authored.glb')
    const key = registerRuntimeGlassesConfig('__authored__', engineModelConfig)
    const cfg = getGlassesConfig(key)

    expect(cfg.preserveMaterials).toBe(true)
  })
})
