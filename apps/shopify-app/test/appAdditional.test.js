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

    expect(url.origin).toBe('https://admin.shopify.com')
    expect(url.pathname).toBe('/store/help-recovery/themes/current/editor')
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
    // Theme editor destinations use the shared TopLevelAdminAction control
    // (an <s-button icon="external"> whose onClick does window.open(href,
    // '_top') -- see topLevelAdminAction.ui.test.js for that behavior's own
    // coverage), not a raw admin.shopify.com anchor: App Bridge can intercept
    // navigation from a Polaris s-* component's href/target, so the actual
    // top-level break-out has to happen imperatively.
    expect(html).not.toMatch(/<a[^>]+href="https:\/\/admin\.shopify\.com[^>]*>/)
    expect(html.match(/icon="external"/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(html).toContain('accessibilityLabel="Open theme editor to adjust glasses size"')
    expect(html).toContain('accessibilityLabel="Open theme editor to add the AR Try-On block"')
    expect(html).not.toMatch(/Check fit/)
    expect(html).toContain('Review fit')
  })
})
