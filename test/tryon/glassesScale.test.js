import { describe, it, expect } from 'vitest'
import { resolveGlassesScaleMultiplier } from '../../src/core/glassesScale.js'

describe('resolveGlassesScaleMultiplier', () => {
  it('honors a positive ?gscale override', () => {
    expect(resolveGlassesScaleMultiplier('?gscale=1.3')).toBeCloseTo(1.3)
  })

  it('defaults to 1.0 when no override is given', () => {
    expect(resolveGlassesScaleMultiplier('')).toBe(1)
  })

  it('ignores a non-positive or non-numeric gscale', () => {
    expect(resolveGlassesScaleMultiplier('?gscale=0')).toBe(1)
    expect(resolveGlassesScaleMultiplier('?gscale=-2')).toBe(1)
    expect(resolveGlassesScaleMultiplier('?gscale=abc')).toBe(1)
  })
})
