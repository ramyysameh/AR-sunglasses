import { describe, it, expect } from 'vitest'
import {
  PLAN_LIMITS,
  GRACE_PERIOD_DAYS,
  planLimit,
  isServable,
  requireActivePlanForAction,
} from '../app/billing.server.js'

function fakeAdmin(activeSubscriptions) {
  return {
    graphql: async () =>
      new Response(JSON.stringify({ data: { currentAppInstallation: { activeSubscriptions } } })),
  }
}

describe('planLimit', () => {
  it('maps each known plan name to its product cap', () => {
    expect(planLimit('Starter')).toBe(10)
    expect(planLimit('Growth')).toBe(40)
    expect(planLimit('Pro')).toBe(Infinity)
  })

  it('fails CLOSED for an unknown or missing plan name', () => {
    // A dashboard/code name mismatch must block everything, never unlock it.
    expect(planLimit('Enterprise')).toBe(0)
    expect(planLimit(undefined)).toBe(0)
    expect(planLimit(null)).toBe(0)
  })

  it('exposes the tier table and grace window as constants', () => {
    expect(PLAN_LIMITS).toEqual({ Starter: 10, Growth: 40, Pro: Infinity })
    expect(GRACE_PERIOD_DAYS).toBe(7)
  })
})

describe('isServable', () => {
  const now = new Date('2026-07-26T12:00:00Z')

  it('serves an ACTIVE subscription', () => {
    expect(isServable({ status: 'ACTIVE', graceEndsAt: null }, now)).toBe(true)
  })

  it('serves a lapsed subscription still inside its grace window', () => {
    const graceEndsAt = new Date(now.getTime() + 24 * 3600 * 1000)
    expect(isServable({ status: 'CANCELLED', graceEndsAt }, now)).toBe(true)
  })

  it('does NOT serve once the grace window has passed', () => {
    const graceEndsAt = new Date(now.getTime() - 1)
    expect(isServable({ status: 'CANCELLED', graceEndsAt }, now)).toBe(false)
  })

  it('does NOT serve a never-subscribed shop (no row)', () => {
    expect(isServable(null, now)).toBe(false)
    expect(isServable(undefined, now)).toBe(false)
  })

  it('does NOT serve a lapsed subscription with no grace timestamp', () => {
    expect(isServable({ status: 'FROZEN', graceEndsAt: null }, now)).toBe(false)
  })
})

describe('requireActivePlanForAction', () => {
  it('returns an error object when there is no active plan', async () => {
    const admin = fakeAdmin([])
    const result = await requireActivePlanForAction(admin)
    expect(result?.error).toMatch(/no active subscription/i)
  })

  it('returns null when a plan is active', async () => {
    const admin = fakeAdmin([{ name: 'Growth', status: 'ACTIVE' }])
    expect(await requireActivePlanForAction(admin)).toBeNull()
  })
})
