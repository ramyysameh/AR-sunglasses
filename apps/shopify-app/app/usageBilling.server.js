import { tagged } from './errors.server.js'

/**
 * Reports paid AI-model saves to Shopify App Pricing through the App Events
 * API. The Partner Dashboard meter `ai_model_generated` is fixed $5 with 0
 * included units: the free lifetime allowance is enforced by
 * generations.server.js, so only paid saves are ever sent here.
 *
 * Billing idempotency is permanent on Shopify's side, so re-sending the same
 * key after a failure can never charge twice.
 */

export const APP_EVENTS_VERSION = '2026-10'
export const AI_MODEL_METER = 'ai_model_generated'

const TOKEN_URL = 'https://api.shopify.com/auth/access_token'
const EVENTS_URL = `https://api.shopify.com/app/${APP_EVENTS_VERSION}/events`

let cachedToken = null // { token, expiresAt } -- tokens last 60 minutes

/** Test seam. */
export function resetAppEventsToken() {
  cachedToken = null
}

async function accessToken(fetchImpl, now) {
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.token
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_APP_EVENTS_CLIENT_ID,
      client_secret: process.env.SHOPIFY_APP_EVENTS_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  })
  if (!res.ok) throw tagged('APP_EVENTS_AUTH', `app events token request failed: ${res.status}`)
  const body = await res.json()
  cachedToken = { token: body.access_token, expiresAt: now + body.expires_in * 1000 }
  return cachedToken.token
}

/**
 * One $5 charge for one saved AI model.
 * @param {{ shopGid: string, idempotencyKey: string, timestamp: Date|string }} charge
 */
export async function reportModelCharge(
  { shopGid, idempotencyKey, timestamp },
  { fetchImpl = fetch, now = Date.now() } = {},
) {
  const token = await accessToken(fetchImpl, now)
  const res = await fetchImpl(EVENTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      shop_id: shopGid,
      event_handle: AI_MODEL_METER,
      timestamp: new Date(timestamp).toISOString(),
      idempotency_key: idempotencyKey,
      attributes: { value: 1 },
    }),
  })
  if (res.status === 401) cachedToken = null
  if (!res.ok) throw tagged('APP_EVENTS_REJECTED', `app event rejected: ${res.status}`)
  const body = await res.json().catch(() => ({}))
  if (body.success === false) throw tagged('APP_EVENTS_REJECTED', `app event rejected: ${body.error}`)
}
