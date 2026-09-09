import { describe, it, expect } from 'vitest'
import {
  fetchActiveSubscription,
  reconcileShop,
  reconcileAll,
} from '../app/reconcileSubscriptions.server.js'
import { GRACE_PERIOD_DAYS } from '../app/billing.server.js'

const API = '2025-10'
const NOW = new Date('2026-09-10T00:00:00Z')

function fakePrisma(rows = [], sessions = []) {
  const table = new Map(rows.map((r) => [r.shop, { ...r }]))
  return {
    _table: table,
    shopSubscription: {
      findUnique: async ({ where: { shop } }) => table.get(shop) ?? null,
      upsert: async ({ where: { shop }, update, create }) => {
        const row = table.has(shop)
          ? { ...table.get(shop), ...update }
          : { ...create }
        table.set(shop, row)
        return row
      },
    },
    session: { findMany: async () => sessions },
  }
}

// a fetch that returns the given active subscriptions for any shop
const okFetch = (subs) => async () =>
  new Response(
    JSON.stringify({ data: { currentAppInstallation: { activeSubscriptions: subs } } }),
  )

describe('fetchActiveSubscription', () => {
  it('returns the ACTIVE subscription, or null when there is none', async () => {
    expect(
      await fetchActiveSubscription('s.myshopify.com', 't', API, okFetch([{ name: 'Pro', status: 'ACTIVE' }])),
    ).toEqual({ name: 'Pro', status: 'ACTIVE' })
    expect(await fetchActiveSubscription('s.myshopify.com', 't', API, okFetch([]))).toBeNull()
  })

  it('throws on a transport failure instead of reporting "no subscription"', async () => {
    const bad = async () => new Response('rate limited', { status: 429 })
    // a 429 must never be the reason a paying shop gets cut off
    await expect(fetchActiveSubscription('s.myshopify.com', 't', API, bad)).rejects.toThrow('429')
  })
})

describe('reconcileShop', () => {
  it('corrects a stale ACTIVE row when Shopify reports no subscription', async () => {
    const prisma = fakePrisma([
      { shop: 's.myshopify.com', planName: 'Starter', status: 'ACTIVE', graceEndsAt: null },
    ])
    const r = await reconcileShop(prisma, 's.myshopify.com', {
      accessToken: 't', apiVersion: API, now: NOW, fetchImpl: okFetch([]),
    })
    expect(r.action).toBe('corrected')
    expect(r.before).toBe('Starter/ACTIVE')
    const row = prisma._table.get('s.myshopify.com')
    expect(row.status).toBe('CANCELLED')
    expect(row.graceEndsAt).toEqual(
      new Date(NOW.getTime() + GRACE_PERIOD_DAYS * 24 * 3600 * 1000),
    )
  })

  it('does NOT create a row for a shop that never subscribed', async () => {
    const prisma = fakePrisma([])
    const r = await reconcileShop(prisma, 'new.myshopify.com', {
      accessToken: 't', apiVersion: API, now: NOW, fetchImpl: okFetch([]),
    })
    // writing one would hand them a free GRACE_PERIOD_DAYS window
    expect(r.action).toBe('skipped')
    expect(prisma._table.size).toBe(0)
  })

  it('leaves a genuinely active shop alone', async () => {
    const prisma = fakePrisma([
      { shop: 's.myshopify.com', planName: 'Pro', status: 'ACTIVE', graceEndsAt: null },
    ])
    const r = await reconcileShop(prisma, 's.myshopify.com', {
      accessToken: 't', apiVersion: API, now: NOW,
      fetchImpl: okFetch([{ name: 'Pro', status: 'ACTIVE' }]),
    })
    expect(r.action).toBe('unchanged')
    expect(prisma._table.get('s.myshopify.com').graceEndsAt).toBeNull()
  })
})

describe('reconcileAll', () => {
  it('keeps going when one shop fails, and dedupes shops', async () => {
    const prisma = fakePrisma(
      [{ shop: 'bad.myshopify.com', planName: 'Pro', status: 'ACTIVE', graceEndsAt: null },
       { shop: 'ok.myshopify.com', planName: 'Starter', status: 'ACTIVE', graceEndsAt: null }],
      [{ shop: 'bad.myshopify.com', accessToken: 't' },
       { shop: 'ok.myshopify.com', accessToken: 't' },
       { shop: 'ok.myshopify.com', accessToken: 't' }, // duplicate session row
       { shop: 'notoken.myshopify.com', accessToken: null }],
    )
    const fetchImpl = async (url) =>
      url.includes('bad.') ? new Response('boom', { status: 500 })
        : new Response(JSON.stringify({ data: { currentAppInstallation: { activeSubscriptions: [] } } }))

    const results = await reconcileAll(prisma, { apiVersion: API, now: NOW, fetchImpl })
    expect(results.map((r) => r.action).sort()).toEqual(['corrected', 'error'])
    expect(prisma._table.get('ok.myshopify.com').status).toBe('CANCELLED')
    // the failed shop must be left untouched, not cut off
    expect(prisma._table.get('bad.myshopify.com').status).toBe('ACTIVE')
  })
})
