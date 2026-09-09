import { describe, it, expect } from 'vitest'
import {
  PLAN_LIMITS,
  GRACE_PERIOD_DAYS,
  planLimit,
  isServable,
  hasFreeAccess,
  parseFreeAccessUntil,
  getActivePlanName,
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

describe('hasFreeAccess (owner comp)', () => {
  const OWNER = 'xmcjg8-uh.myshopify.com' // default FREE_ACCESS_SHOPS entry

  it('comps the owner shop and rejects everyone else', () => {
    expect(hasFreeAccess(OWNER)).toBe(true)
    expect(hasFreeAccess(OWNER.toUpperCase())).toBe(true) // case-insensitive
    expect(hasFreeAccess('someone-else.myshopify.com')).toBe(false)
    expect(hasFreeAccess(null)).toBe(false)
    expect(hasFreeAccess(undefined)).toBe(false)
  })

  it('reads the owner shop as the top plan WITHOUT calling Shopify', async () => {
    let called = false
    const admin = {
      graphql: async () => {
        called = true
        return new Response(JSON.stringify({ data: { currentAppInstallation: { activeSubscriptions: [] } } }))
      },
    }
    expect(await getActivePlanName(admin, OWNER)).toBe('Pro')
    expect(called).toBe(false)
  })

  it('still requires a real subscription for a non-comped shop', async () => {
    expect(await getActivePlanName(fakeAdmin([]), 'someone-else.myshopify.com')).toBeNull()
  })
})

describe('parseFreeAccessUntil (extended free trial)', () => {
  it('parses shop:date pairs, lowercasing the domain', () => {
    const m = parseFreeAccessUntil('Foo.myshopify.com:2026-10-15, bar.myshopify.com:2026-11-30')
    expect([...m.keys()]).toEqual(['foo.myshopify.com', 'bar.myshopify.com'])
    // the named date is the LAST day of access, inclusive
    expect(m.get('foo.myshopify.com').toISOString()).toBe('2026-10-15T23:59:59.999Z')
  })

  it('drops malformed entries instead of granting access (fails closed)', () => {
    const m = parseFreeAccessUntil('no-date.myshopify.com,bad.myshopify.com:not-a-date,:2026-10-15')
    expect(m.size).toBe(0)
    expect(parseFreeAccessUntil('').size).toBe(0)
    expect(parseFreeAccessUntil(undefined).size).toBe(0)
  })
})

describe('hasFreeAccess time window', () => {
  const OWNER = 'xmcjg8-uh.myshopify.com'

  it('comps the permanent list regardless of the clock', () => {
    expect(hasFreeAccess(OWNER, new Date('2099-01-01T00:00:00Z'))).toBe(true)
  })

  it('leaves a shop with no comp entry gated at any time', () => {
    expect(hasFreeAccess('someone-else.myshopify.com', new Date('2026-09-10T00:00:00Z'))).toBe(false)
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
