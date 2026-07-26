import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  getGlassesModelUrl,
  registerRuntimeGlassesConfig,
} from '../../src/config/arConfig.js'
import { toEngineModelConfig } from '../../src/tryon/fitMetadataAdapter.js'

// A merchant model URL as the app serves it: an unguessable UUID.
const MERCHANT_URL = '/models/2f1c6c1e-0e3a-4f6b-9d2a-8c7b5a4e3d21.glb'

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

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getGlassesModelUrl', () => {
  it('returns a bare url in production so the CDN can cache it', () => {
    vi.stubEnv('DEV', false)

    expect(getGlassesModelUrl()).not.toContain('?v=')
  })

  it('appends a cache-buster in dev so a re-exported GLB is refetched', () => {
    vi.stubEnv('DEV', true)

    expect(getGlassesModelUrl()).toMatch(/\?v=\d+$/)
  })

  it('returns a bare url for MERCHANT models in production', () => {
    // This is the customer-facing path and it does NOT go through
    // runtimeModelPath. registerRuntimeGlassesConfig sets useNormalizedModel
    // and useOptimizedModel to false, so getGlassesModelUrl resolves via its
    // else-branch and returns config.modelPath. A test that only covered the
    // default SKU would leave this branch unverified.
    vi.stubEnv('DEV', false)
    const key = registerRuntimeGlassesConfig(
      '__merchant_cache_test__',
      toEngineModelConfig(fit, MERCHANT_URL),
    )

    // Exact equality, not a substring check: proves nothing was appended.
    expect(getGlassesModelUrl(key)).toBe(MERCHANT_URL)
  })
})
