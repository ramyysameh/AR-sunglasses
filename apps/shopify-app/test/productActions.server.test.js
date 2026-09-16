import { describe, expect, it } from 'vitest'
import { handleProductAction } from '../app/productActions.server.js'

describe('handleProductAction', () => {
  it('rejects an unknown intent with the existing response contract', async () => {
    const request = new Request('https://app.test/app/products', {
      method: 'POST',
      body: new URLSearchParams({ intent: 'unknown' }),
    })

    const admin = {
      graphql: async () => new Response(JSON.stringify({
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{ name: 'Pro', status: 'ACTIVE' }],
          },
        },
      })),
    }
    const response = await handleProductAction({ request, admin, shop: 'shop.test' })

    expect(response).toEqual({ error: 'Unknown action.' })
  })
})
