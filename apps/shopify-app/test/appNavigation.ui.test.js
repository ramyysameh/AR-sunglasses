import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-router', () => ({
  Outlet: () => null,
  useLoaderData: () => ({ apiKey: 'test-key', pricingUrl: null }),
  useRouteError: vi.fn(),
}))
vi.mock('@shopify/shopify-app-react-router/react', () => ({
  AppProvider: ({ children }) => children,
}))
vi.mock('@shopify/shopify-app-react-router/server', () => ({
  boundary: { error: vi.fn(), headers: vi.fn() },
}))
vi.mock('../app/shopify.server.js', () => ({ authenticate: { admin: vi.fn() } }))
vi.mock('../app/billing.server.js', () => ({
  getActivePlanName: vi.fn(),
  pricingUrlFor: vi.fn(),
}))

global.React = React

const { default: App } = await import('../app/routes/app.jsx')

describe('app navigation', () => {
  it('keeps only Workspace and Models as global destinations', () => {
    const html = renderToStaticMarkup(React.createElement(App))

    expect(html.match(/<s-link /g)).toHaveLength(2)
    expect(html).toContain('<s-link href="/app">Workspace</s-link>')
    expect(html).toContain('<s-link href="/app/models">Models</s-link>')
  })
})
