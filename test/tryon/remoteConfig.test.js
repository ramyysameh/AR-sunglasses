import { describe, it, expect, vi } from 'vitest'
import {
  fetchRemoteConfig,
  isValidConfigPayload,
  RETRY_MESSAGE,
  UNAVAILABLE_MESSAGE,
} from '../../src/tryon/remoteConfig.js'

const fitMetadata = {
  frameWidthMeters: 0.14,
  bridgeAnchor: [0, 0, 0],
  leftHinge: [-0.07, 0, 0],
  rightHinge: [0.07, 0, 0],
}
const input = { shop: 'demo.myshopify.com', productId: 'gid://shopify/Product/1' }
const respond = (status, body = null) => vi.fn(async () => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
}))

describe('fetchRemoteConfig', () => {
  it('returns the mapped model for this product', async () => {
    const fetchImpl = respond(200, { modelUrl: '/models/a.glb', fitMetadata })
    await expect(fetchRemoteConfig({ ...input, src: 'preview', fetchImpl }))
      .resolves.toEqual({ modelUrl: '/models/a.glb', fitMetadata })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/tryon-config?shop=demo.myshopify.com&productId=gid%3A%2F%2Fshopify%2FProduct%2F1&src=preview',
    )
  })

  it.each([
    [402, 'a lapsed subscription'],
    [404, 'a product with no model mapped'],
  ])('reports %i (%s) as unavailable, with no retry and no stand-in frame', async (status) => {
    await expect(fetchRemoteConfig({ ...input, fetchImpl: respond(status) }))
      .rejects.toMatchObject({ message: UNAVAILABLE_MESSAGE, recoverable: false })
  })

  it('offers a retry for a temporary outage', async () => {
    await expect(fetchRemoteConfig({ ...input, fetchImpl: respond(503) }))
      .rejects.toMatchObject({ message: RETRY_MESSAGE, recoverable: true })
  })

  it('offers a retry when the network request itself fails', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    await expect(fetchRemoteConfig({ ...input, fetchImpl }))
      .rejects.toMatchObject({ message: RETRY_MESSAGE, recoverable: true })
  })

  it('refuses a payload the engine cannot place', async () => {
    await expect(fetchRemoteConfig({ ...input, fetchImpl: respond(200, { modelUrl: '/models/a.glb' }) }))
      .rejects.toMatchObject({ message: UNAVAILABLE_MESSAGE, recoverable: false })
  })
})

describe('isValidConfigPayload', () => {
  it('requires a model URL and every fit anchor', () => {
    expect(isValidConfigPayload({ modelUrl: '/m.glb', fitMetadata })).toBe(true)
    expect(isValidConfigPayload({ fitMetadata })).toBe(false)
    expect(isValidConfigPayload({ modelUrl: '/m.glb', fitMetadata: { ...fitMetadata, leftHinge: null } })).toBe(false)
    expect(isValidConfigPayload(null)).toBe(false)
  })
})
