import { describe, it, expect } from 'vitest'
import { resolveGlassesScaleMultiplier, resolveModelSizeMultiplier } from '../../src/core/glassesScale.js'

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

describe('resolveModelSizeMultiplier', () => {
  it("uses the merchant's per-model size", () => {
    expect(resolveModelSizeMultiplier({ sizeMultiplier: 1.4 })).toBeCloseTo(1.4)
  })

  it('is 1 for built-in SKUs and anything that is not a positive number', () => {
    expect(resolveModelSizeMultiplier(null)).toBe(1)
    expect(resolveModelSizeMultiplier({})).toBe(1)
    expect(resolveModelSizeMultiplier({ sizeMultiplier: 0 })).toBe(1)
    expect(resolveModelSizeMultiplier({ sizeMultiplier: -1 })).toBe(1)
    expect(resolveModelSizeMultiplier({ sizeMultiplier: '1.4' })).toBe(1)
  })
})
