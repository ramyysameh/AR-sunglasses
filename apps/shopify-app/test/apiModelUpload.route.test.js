import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

const shop = `apiupload-${randomUUID().slice(0, 8)}.myshopify.com`
const hoisted = vi.hoisted(() => ({ plan: 'Pro' }))

vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop },
      admin: {
        graphql: async () => new Response(JSON.stringify({
          data: { currentAppInstallation: { activeSubscriptions: hoisted.plan ? [{ name: hoisted.plan, status: 'ACTIVE' }] : [] } },
        })),
      },
    }),
  },
}))

// Isolate the route from the real presign/finalize implementations (those have
// their own tests). Here we only assert the route returns real JSON Responses.
vi.mock('../app/storage.server.js', () => ({
  presignModelUpload: async () => ({ uploadUrl: 'https://bucket.example/put', storageRef: 'uploads/abc.glb' }),
}))
vi.mock('../app/models.server.js', () => ({
  finalizeUpload: async () => ({ assetId: 'a1', status: 'pass', source: 'tagged', confidence: 1, needsManual: false }),
}))

const { action } = await import('../app/routes/api.model-upload.jsx')

function req(fields) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return new Request('https://x/api/model-upload', { method: 'POST', body: fd })
}

describe('api.model-upload resource route', () => {
  it('presign returns a JSON Response with uploadUrl + storageRef', async () => {
    hoisted.plan = 'Pro'
    const res = await action({ request: req({ intent: 'upload-presign' }) })
    expect(res).toBeInstanceOf(Response)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body = await res.json()
    expect(body.uploadUrl).toBe('https://bucket.example/put')
    expect(body.storageRef).toBe('uploads/abc.glb')
  })

  it('finalize returns JSON with the calibration summary', async () => {
    hoisted.plan = 'Pro'
    const res = await action({ request: req({ intent: 'upload-finalize', storageRef: 'uploads/abc.glb', filename: 'm.glb' }) })
    const body = await res.json()
    expect(body.uploaded.status).toBe('pass')
  })

  it('is blocked without an active subscription (402 JSON)', async () => {
    hoisted.plan = null
    const res = await action({ request: req({ intent: 'upload-presign' }) })
    expect(res.status).toBe(402)
    expect((await res.json()).error).toMatch(/no active subscription/i)
  })

  it('unknown intent returns a 400 JSON error', async () => {
    hoisted.plan = 'Pro'
    const res = await action({ request: req({ intent: 'bogus' }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/unknown action/i)
  })
})
