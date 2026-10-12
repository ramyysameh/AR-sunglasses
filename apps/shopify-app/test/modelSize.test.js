import { describe, it, expect } from 'vitest'
import { formatModelSize, parseModelSize, sizeToSubmit } from '../app/modelSize.js'

describe('parseModelSize', () => {
  it('accepts a size inside the slider range, snapped to its step', () => {
    expect(parseModelSize('1')).toBe(1)
    expect(parseModelSize('1.25')).toBe(1.25)
    expect(parseModelSize('0.5')).toBe(0.5)
    expect(parseModelSize('2.5')).toBe(2.5)
    // Snapped, and free of float noise (25 * 0.05 is 1.2500000000000002).
    expect(parseModelSize('1.27')).toBe(1.25)
    expect(parseModelSize('1.28')).toBe(1.3)
  })

  it('refuses anything else instead of clamping it', () => {
    for (const raw of ['0.49', '2.51', '0', '-1', 'abc', '', '  ', null, undefined, 'Infinity']) {
      expect(parseModelSize(raw)).toBeNull()
    }
  })
})

describe('sizeToSubmit', () => {
  it('saves a released slider only when the size changed', () => {
    expect(sizeToSubmit('1.5', 1)).toBe(1.5)
    expect(sizeToSubmit('1', 1)).toBeNull()
    expect(sizeToSubmit('1.01', 1)).toBeNull()
    expect(sizeToSubmit('nope', 1)).toBeNull()
  })
})

describe('formatModelSize', () => {
  it('reads as a multiplier without trailing zeros', () => {
    expect(formatModelSize(1)).toBe('1×')
    expect(formatModelSize(1.25)).toBe('1.25×')
    expect(formatModelSize(1.5)).toBe('1.5×')
  })
})
