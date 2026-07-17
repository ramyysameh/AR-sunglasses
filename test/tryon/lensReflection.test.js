import { describe, it, expect } from 'vitest'
import { resolveLensReflectionConfig, applyLensReflection } from '../../src/core/lensReflection.js'

describe('resolveLensReflectionConfig', () => {
  it('defaults to the baked device-tuned values', () => {
    const config = resolveLensReflectionConfig('')
    expect(config.intensity).toBeCloseTo(1.8)
    expect(config.roughness).toBeCloseTo(0.06)
    expect(config.sunAzimuthDeg).toBeCloseTo(35)
    // Near the horizon on purpose: a lens facing the camera reflects the
    // elevation-0 ring at any head yaw, so a high sun is never reflected at all.
    expect(config.sunElevationDeg).toBeCloseTo(5)
  })

  it('honours every override', () => {
    const config = resolveLensReflectionConfig('?lensrefl=2.5&lensrough=0.2&sunaz=-90&sunel=60')
    expect(config.intensity).toBeCloseTo(2.5)
    expect(config.roughness).toBeCloseTo(0.2)
    expect(config.sunAzimuthDeg).toBeCloseTo(-90)
    expect(config.sunElevationDeg).toBeCloseTo(60)
  })

  it('ignores non-numeric and out-of-range values', () => {
    const config = resolveLensReflectionConfig('?lensrefl=abc&lensrough=5&sunel=400')
    expect(config.intensity).toBeCloseTo(1.8)
    expect(config.roughness).toBeCloseTo(0.06)
    expect(config.sunElevationDeg).toBeCloseTo(5)
  })

  it('allows a zero intensity so reflections can be switched off for comparison', () => {
    expect(resolveLensReflectionConfig('?lensrefl=0').intensity).toBe(0)
  })
})

describe('applyLensReflection', () => {
  const config = { intensity: 1.8, roughness: 0.06, sunAzimuthDeg: 35, sunElevationDeg: 28 }
  const envMap = { name: 'env' }

  it('assigns the env map and intensity', () => {
    const material = { roughness: 0.5 }
    applyLensReflection(material, envMap, config)
    expect(material.envMap).toBe(envMap)
    expect(material.envMapIntensity).toBeCloseTo(1.8)
  })

  it('clamps a mirror-smooth authored lens up to the roughness floor', () => {
    // Smoke_Lens in gripzpelmo.glb is authored at roughness 0; at true zero the
    // sun reflects as a hard aliased dot.
    const material = { roughness: 0 }
    applyLensReflection(material, envMap, config)
    expect(material.roughness).toBeCloseTo(0.06)
  })

  it('leaves a rougher authored lens alone', () => {
    const material = { roughness: 0.3 }
    applyLensReflection(material, envMap, config)
    expect(material.roughness).toBeCloseTo(0.3)
  })

  it('does nothing without an env map', () => {
    const material = { roughness: 0 }
    applyLensReflection(material, null, config)
    expect(material.envMap).toBeUndefined()
    expect(material.roughness).toBe(0)
  })
})
