import { describe, it, expect } from 'vitest'
import { resolveGlassesScaleMultiplier } from '../../src/core/glassesScale.js'

describe('resolveGlassesScaleMultiplier', () => {
  it('honors a positive ?gscale override regardless of orientation', () => {
    expect(resolveGlassesScaleMultiplier('?gscale=1.3', true)).toBeCloseTo(1.3)
    expect(resolveGlassesScaleMultiplier('?gscale=1.3', false)).toBeCloseTo(1.3)
  })

  it('defaults to 1.7 in portrait when no override is given', () => {
    expect(resolveGlassesScaleMultiplier('', true)).toBeCloseTo(1.7)
  })

  it('defaults to 1.0 in landscape when no override is given', () => {
    expect(resolveGlassesScaleMultiplier('', false)).toBe(1)
  })

  it('ignores a non-positive or non-numeric gscale', () => {
    expect(resolveGlassesScaleMultiplier('?gscale=0', true)).toBeCloseTo(1.7)
    expect(resolveGlassesScaleMultiplier('?gscale=-2', true)).toBeCloseTo(1.7)
    expect(resolveGlassesScaleMultiplier('?gscale=abc', false)).toBe(1)
  })
})
