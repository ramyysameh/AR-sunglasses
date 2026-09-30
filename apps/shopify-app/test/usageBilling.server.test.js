import { describe, it, expect, beforeEach, vi } from 'vitest'
import { reportModelCharge, resetAppEventsToken, AI_MODEL_METER } from '../app/usageBilling.server.js'

function fakeFetch({ tokenStatus = 200, eventStatus = 202, eventBody = { success: true } } = {}) {
  return vi.fn(async (url, init) => {
    if (url === 'https://api.shopify.com/auth/access_token') {
      return new Response(JSON.stringify({ access_token: 'tok_1', expires_in: 3599 }), { status: tokenStatus })
    }
    return new Response(JSON.stringify(eventBody), { status: eventStatus })
  })
}

const charge = { shopGid: 'gid://shopify/Shop/42', idempotencyKey: 'aimodel_abc', timestamp: new Date('2026-10-01T10:00:00Z') }

beforeEach(() => {
  resetAppEventsToken()
  vi.stubEnv('SHOPIFY_APP_EVENTS_CLIENT_ID', 'cid')
  vi.stubEnv('SHOPIFY_APP_EVENTS_CLIENT_SECRET', 'csecret')
})

describe('reportModelCharge', () => {
  it('gets a client-credentials token, then posts one $5 meter event', async () => {
    const fetchImpl = fakeFetch()
    await reportModelCharge(charge, { fetchImpl, now: 0 })

    const [authUrl, authInit] = fetchImpl.mock.calls[0]
    expect(authUrl).toBe('https://api.shopify.com/auth/access_token')
    expect(JSON.parse(authInit.body)).toEqual({ client_id: 'cid', client_secret: 'csecret', grant_type: 'client_credentials' })

    const [eventUrl, eventInit] = fetchImpl.mock.calls[1]
    expect(eventUrl).toBe('https://api.shopify.com/app/2026-10/events')
    expect(eventInit.headers.Authorization).toBe('Bearer tok_1')
    expect(JSON.parse(eventInit.body)).toEqual({
      shop_id: 'gid://shopify/Shop/42',
      event_handle: AI_MODEL_METER,
      timestamp: '2026-10-01T10:00:00.000Z',
      idempotency_key: 'aimodel_abc',
      attributes: { value: 1 },
    })
    expect(AI_MODEL_METER).toBe('ai_model_generated')
  })

  it('reuses the token until a minute before it expires', async () => {
    const fetchImpl = fakeFetch()
    await reportModelCharge(charge, { fetchImpl, now: 0 })
    await reportModelCharge(charge, { fetchImpl, now: 3_000_000 })
    expect(fetchImpl.mock.calls.filter(([u]) => u.endsWith('/access_token'))).toHaveLength(1)
    await reportModelCharge(charge, { fetchImpl, now: 3_560_000 })
    expect(fetchImpl.mock.calls.filter(([u]) => u.endsWith('/access_token'))).toHaveLength(2)
  })

  it('throws APP_EVENTS_AUTH when the token request fails', async () => {
    await expect(reportModelCharge(charge, { fetchImpl: fakeFetch({ tokenStatus: 401 }), now: 0 }))
      .rejects.toMatchObject({ code: 'APP_EVENTS_AUTH' })
  })

  it('throws APP_EVENTS_REJECTED on a non-2xx event response or success:false', async () => {
    await expect(reportModelCharge(charge, { fetchImpl: fakeFetch({ eventStatus: 409 }), now: 0 }))
      .rejects.toMatchObject({ code: 'APP_EVENTS_REJECTED' })
    resetAppEventsToken()
    await expect(reportModelCharge(charge, { fetchImpl: fakeFetch({ eventBody: { success: false, error: 'bad' } }), now: 0 }))
      .rejects.toMatchObject({ code: 'APP_EVENTS_REJECTED' })
  })

  it('drops a cached token that the events API rejects as unauthorized', async () => {
    const fetchImpl = fakeFetch({ eventStatus: 401 })
    await expect(reportModelCharge(charge, { fetchImpl, now: 0 })).rejects.toBeTruthy()
    await expect(reportModelCharge(charge, { fetchImpl, now: 1 })).rejects.toBeTruthy()
    expect(fetchImpl.mock.calls.filter(([u]) => u.endsWith('/access_token'))).toHaveLength(2)
  })
})
