import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const shop = 'help-recovery.myshopify.com'
const routeState = vi.hoisted(() => ({ loaderData: null }))

vi.mock('react-router', () => ({
  useLoaderData: () => routeState.loaderData,
}))
vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({ session: { shop } }),
  },
}))

global.React = React

const { default: HelpPage, loader } = await import('../app/routes/app.additional.jsx')

describe('Help loader', () => {
  it('returns a theme editor URL for the authenticated shop', async () => {
    const result = await loader({ request: new Request('https://example.test/app/additional') })
    const url = new URL(result.themeEditorUrl)

    expect(url.origin).toBe('https://help-recovery.myshopify.com')
    expect(url.pathname).toBe('/admin/themes/current/editor')
    expect(url.searchParams.get('template')).toBe('product')
    expect(url.searchParams.get('addAppBlockId')).toMatch(/\/tryon_button$/)
  })
})

describe('Help recovery actions', () => {
  it('renders every recovery destination with the required browsing target', () => {
    routeState.loaderData = {
      themeEditorUrl: 'https://admin.shopify.com/store/help-recovery/themes/current/editor?template=product',
    }

    const html = renderToStaticMarkup(React.createElement(HelpPage))

    expect(html).not.toMatch(
      /<s-page[^>]*inlineSize="small"[^>]*>[\s\S]*<s-section[^>]*slot="aside"/,
    )
    expect(html).toContain('href="/app/products"')
    expect(html).toContain('href="/app/models"')
    expect(html).toContain('href="/privacy" target="_blank"')
    expect(html).toContain('href="mailto:ramy.sameh2@gmail.com"')
    expect(html).toContain(
      'href="https://admin.shopify.com/store/help-recovery/themes/current/editor?template=product" target="_top" rel="noreferrer"',
    )
  })
})
