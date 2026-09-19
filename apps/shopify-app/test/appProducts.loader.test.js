import { describe, expect, it, vi } from 'vitest'

const authenticateAdmin = vi.fn(async () => ({
  session: { shop: 'bookmarked-products.myshopify.com' },
}))

vi.mock('../app/shopify.server.js', () => ({
  authenticate: { admin: authenticateAdmin },
}))
vi.mock('@shopify/shopify-app-react-router/server', () => ({
  boundary: { headers: vi.fn() },
}))

const { loader } = await import('../app/routes/app.products.jsx')

describe('app.products loader', () => {
  it('authenticates an existing bookmark before redirecting to Workspace', async () => {
    const request = new Request('https://x/app/products')

    const response = await loader({ request })

    expect(authenticateAdmin).toHaveBeenCalledWith(request)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/app')
  })
})
