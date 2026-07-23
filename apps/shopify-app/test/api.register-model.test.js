import { describe, it, expect, vi, afterEach } from 'vitest'

const hoisted = vi.hoisted(() => ({ error: null, result: null }))

vi.mock('../app/models.server.js', () => ({
  registerModelByUrl: async () => {
    if (hoisted.error) throw hoisted.error
    return hoisted.result
  },
}))
vi.mock('../app/db.server.js', () => ({ default: {} }))

const { loader } = await import('../app/routes/api.register-model.jsx')

const call = (url) => loader({ request: new Request(url) })
const GOOD =
  'https://app.test/api/register-model?url=https%3A%2F%2Fcdn.shopify.com%2Fa.glb&shop=s.myshopify.com'

afterEach(() => {
  hoisted.error = null
  hoisted.result = null
})

describe('GET /api/register-model', () => {
  it('returns 400 when url is missing', async () => {
    expect((await call('https://app.test/api/register-model?shop=s.myshopify.com')).status).toBe(400)
  })

  it('returns 400 when shop is missing', async () => {
    expect(
      (await call('https://app.test/api/register-model?url=https%3A%2F%2Fcdn.shopify.com%2Fa.glb'))
        .status,
    ).toBe(400)
  })

  it.each([
    ['URL_NOT_ALLOWED', 400],
    ['SHOP_INVALID', 400],
    ['SHOP_NOT_INSTALLED', 403],
    ['QUOTA_EXCEEDED', 429],
    ['FETCH_FAILED', 422],
    ['TOO_LARGE', 422],
  ])('maps %s to %i', async (code, status) => {
    hoisted.error = Object.assign(new Error('internal detail'), { code })
    expect((await call(GOOD)).status).toBe(status)
  })

  it('fails closed to 500 for an uncoded error', async () => {
    // A new throw site that forgets to tag must not leak its message.
    hoisted.error = new Error('some raw internal failure')
    expect((await call(GOOD)).status).toBe(500)
  })

  it.each([
    ['URL_NOT_ALLOWED'],
    ['SHOP_NOT_INSTALLED'],
    ['QUOTA_EXCEEDED'],
    ['FETCH_FAILED'],
    ['TOO_LARGE'],
  ])('never leaks the internal message for %s', async (code) => {
    hoisted.error = Object.assign(new Error('SECRET-INTERNAL-DETAIL'), { code })
    const body = await (await call(GOOD)).text()
    expect(body).not.toContain('SECRET-INTERNAL-DETAIL')
  })

  it('does not leak the internal message on an uncoded 500', async () => {
    hoisted.error = new Error('SECRET-INTERNAL-DETAIL')
    const body = await (await call(GOOD)).text()
    expect(body).not.toContain('SECRET-INTERNAL-DETAIL')
  })

  it('sends no CORS header — the engine is same-origin', async () => {
    hoisted.result = { modelUrl: '/models/x.glb', fitMetadata: { version: 'eyewear-v1' } }
    const res = await call(GOOD)
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})
