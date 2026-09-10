import { describe, it, expect } from 'vitest'
import { resolveFrameReflectionConfig, applyFrameReflection } from '../../src/core/frameReflection.js'

const ENV_MAP = { isTexture: true }

// A glossy frame as authored in the GLB: low roughness, full clearcoat.
function glossyFrameMaterial() {
  return { roughness: 0.07, metalness: 0, clearcoat: 1, clearcoatRoughness: 0, envMap: null, envMapIntensity: 1 }
}

describe('resolveFrameReflectionConfig', () => {
  it('defaults to a restrained intensity so the frame does not read as glare', () => {
    const config = resolveFrameReflectionConfig('')
    expect(config.intensity).toBeCloseTo(0.25)
    expect(config.roughness).toBeCloseTo(0.06)
    expect(config.clearcoatRoughness).toBeCloseTo(0.1)
  })

  it('honours every override', () => {
    const config = resolveFrameReflectionConfig('?framerefl=0.8&framerough=0.2&frameccrough=0.35')
    expect(config.intensity).toBeCloseTo(0.8)
    expect(config.roughness).toBeCloseTo(0.2)
    expect(config.clearcoatRoughness).toBeCloseTo(0.35)
  })

  it('ignores non-numeric and out-of-range values', () => {
    const config = resolveFrameReflectionConfig('?framerefl=abc&framerough=5&frameccrough=-1')
    expect(config.intensity).toBeCloseTo(0.25)
    expect(config.roughness).toBeCloseTo(0.06)
    expect(config.clearcoatRoughness).toBeCloseTo(0.1)
  })

  it('allows ?framerefl=0 to restore the fully flat frame 2e12c0f had', () => {
    expect(resolveFrameReflectionConfig('?framerefl=0').intensity).toBe(0)
  })
})

describe('applyFrameReflection', () => {
  const config = { intensity: 0.25, roughness: 0.06, clearcoatRoughness: 0.1 }

  // The bug this fixes: ambient light casts no specular and no env map was ever
  // assigned to the frame, so an authored-glossy frame rendered exactly like a
  // matte one. An env map is the whole point -- without it there is nothing to
  // reflect, whatever the GLB says about roughness.
  it('gives the frame an env map to reflect', () => {
    const material = glossyFrameMaterial()
    applyFrameReflection(material, ENV_MAP, config)
    expect(material.envMap).toBe(ENV_MAP)
    expect(material.envMapIntensity).toBeCloseTo(0.25)
  })

  it('leaves authored gloss alone -- never smooths a frame the GLB made rough', () => {
    const matte = { roughness: 0.55, clearcoat: 0, clearcoatRoughness: 0, envMap: null, envMapIntensity: 1 }
    applyFrameReflection(matte, ENV_MAP, config)
    expect(matte.roughness).toBeCloseTo(0.55)
  })

  it('raises a near-mirror frame to the roughness floor so the sun does not alias', () => {
    const mirror = { roughness: 0, clearcoat: 0, clearcoatRoughness: 0, envMap: null, envMapIntensity: 1 }
    applyFrameReflection(mirror, ENV_MAP, config)
    expect(mirror.roughness).toBeCloseTo(0.06)
  })

  it('floors clearcoatRoughness on an authored coat', () => {
    const material = glossyFrameMaterial()
    applyFrameReflection(material, ENV_MAP, config)
    expect(material.clearcoatRoughness).toBeCloseTo(0.1)
  })

  it('never switches clearcoat ON -- a matte acetate frame must not look lacquered', () => {
    const uncoated = { roughness: 0.4, clearcoat: 0, clearcoatRoughness: 0, envMap: null, envMapIntensity: 1 }
    applyFrameReflection(uncoated, ENV_MAP, config)
    expect(uncoated.clearcoat).toBe(0)
    expect(uncoated.clearcoatRoughness).toBe(0)
  })

  it('is a no-op at zero intensity, leaving the frame with no env map at all', () => {
    const material = glossyFrameMaterial()
    applyFrameReflection(material, ENV_MAP, { ...config, intensity: 0 })
    expect(material.envMap).toBeNull()
  })

  it('is a no-op when the env map or config is missing', () => {
    const noEnv = glossyFrameMaterial()
    applyFrameReflection(noEnv, null, config)
    expect(noEnv.envMap).toBeNull()

    const noConfig = glossyFrameMaterial()
    applyFrameReflection(noConfig, ENV_MAP, null)
    expect(noConfig.envMap).toBeNull()
  })

  it('tolerates a material with no clearcoat support (plain standard material)', () => {
    const standard = { roughness: 0.2, envMap: null, envMapIntensity: 1 }
    expect(() => applyFrameReflection(standard, ENV_MAP, config)).not.toThrow()
    expect(standard.envMap).toBe(ENV_MAP)
  })
})
