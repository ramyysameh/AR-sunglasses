import { describe, expect, it } from 'vitest'
import { setupSteps } from '../app/setupSteps.server.js'

const states = (input) => setupSteps(input).steps.map((s) => s.state)

describe('setupSteps', () => {
  const asset = { id: 'a', status: 'ready' }
  it('starts at creating models', () => {
    expect(states({ assets: [], mappings: [], storeLive: false })).toEqual(['current', 'upcoming', 'upcoming'])
  })
  it('moves to saving once a model exists, then to turning on', () => {
    expect(states({ assets: [asset], mappings: [], storeLive: false })).toEqual(['done', 'current', 'upcoming'])
    expect(states({ assets: [asset], mappings: [{ id: 'm' }], storeLive: false })).toEqual(['done', 'done', 'current'])
  })
  it('is done when the store has try-on on', () => {
    const setup = setupSteps({ assets: [asset], mappings: [{ id: 'm' }], storeLive: true })
    expect(setup.done).toBe(true)
    expect(setup.steps.every((s) => s.state === 'done')).toBe(true)
  })
  it('counts only ready (or reviewed) models for step one when nothing is mapped', () => {
    expect(states({ assets: [{ id: 'x', status: 'needs_manual' }], mappings: [], storeLive: false })[0]).toBe('current')
    expect(states({ assets: [{ id: 'x', status: 'needs_manual', fitReviewedAt: new Date() }], mappings: [], storeLive: false })[0]).toBe('done')
  })
  it('treats an existing mapping as step one done even with no ready asset', () => {
    expect(states({ assets: [], mappings: [{ id: 'm' }], storeLive: false })).toEqual(['done', 'done', 'current'])
    expect(states({ assets: [{ id: 'x', status: 'needs_manual' }], mappings: [{ id: 'm' }], storeLive: true })).toEqual(['done', 'done', 'done'])
  })
})
