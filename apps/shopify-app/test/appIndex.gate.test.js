import { describe, it, expect, vi } from 'vitest'

// app._index is the index route of `/app`. If its loader throws
// redirect('/app') when there's no active subscription, it redirects to itself
// forever -- an infinite loop that renders a dead, control-less page (exactly
// the "entire page is the text 200 / no interactable controls" App Store
// rejection). The app.jsx layout owns the no-subscription screen, so this
// loader must resolve quietly instead of throwing its own redirect.

const hoisted = vi.hoisted(() => ({ plan: null }))
vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: 'idx-test.myshopify.com' },
      admin: {
        graphql: async () =>
          new Response(
            JSON.stringify({
              data: {
                currentAppInstallation: {
                  activeSubscriptions: hoisted.plan
                    ? [{ name: hoisted.plan, status: 'ACTIVE' }]
                    : [],
                },
              },
            }),
          ),
      },
    }),
  },
}))

const { loader } = await import('../app/routes/app._index.jsx')

describe('app index loader subscription gate', () => {
  it('does NOT throw a redirect when there is no active subscription', async () => {
    hoisted.plan = null
    await expect(
      loader({ request: new Request('https://x/app') }),
    ).resolves.toBeNull()
  })

  it('resolves normally with an active subscription', async () => {
    hoisted.plan = 'Starter'
    await expect(
      loader({ request: new Request('https://x/app') }),
    ).resolves.toBeNull()
  })
})
