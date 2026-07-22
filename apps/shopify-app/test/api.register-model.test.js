import { describe, it, expect } from 'vitest'
import { loader } from '../app/routes/api.register-model.jsx'

const call = (url) => loader({ request: new Request(url) })

describe('GET /api/register-model — validation', () => {
  it('returns 400 with permissive CORS when url is missing', async () => {
    const res = await call('https://app.test/api/register-model')
    expect(res.status).toBe(400)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('returns 400 when url is not an https URL', async () => {
    const res = await call('https://app.test/api/register-model?url=http%3A%2F%2Fx%2Fm.glb')
    expect(res.status).toBe(400)
  })

  it('rejects a request with no shop so no unattributable asset is created', async () => {
    const response = await loader({
      request: new Request('https://app.test/api/register-model?url=https%3A%2F%2Fcdn.shopify.com%2Fa.glb'),
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/shop is required/)
  })
})
