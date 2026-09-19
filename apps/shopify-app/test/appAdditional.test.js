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

// Walks a returned React element tree (plain objects with .type/.props, as
// returned by calling a hook-free component function directly) collecting
// every node matching `predicate` -- same shape as appProducts.ui.test.js's
// findElement, but collecting all matches instead of the first, and also
// expanding function-component nodes (e.g. <TopLevelAdminAction .../>): a
// tree built this way (not through React's own renderer) never reconciles
// child components on its own, so without this a node like
// TopLevelAdminAction never resolves to the <s-button> it renders, and this
// walk would silently find nothing under it.
function findAllElements(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  if (typeof node.type === 'function') {
    findAllElements(node.type(node.props), predicate, out)
  }
  const children = node.props?.children
  if (children === undefined) return out
  const list = Array.isArray(children) ? children : [children]
  for (const child of list) findAllElements(child, predicate, out)
  return out
}

describe('Help loader', () => {
  it('returns a theme editor URL for the authenticated shop', async () => {
    const result = await loader({ request: new Request('https://example.test/app/additional') })
    const url = new URL(result.themeEditorUrl)

    expect(url.origin).toBe('https://help-recovery.myshopify.com')
    expect(url.pathname).toBe('/admin/themes/current/editor')
    expect(url.searchParams.get('template')).toBe('product')
    expect(url.searchParams.get('addAppBlockId')).toBe(
      'be1db9d64c7c617dcd67f6add58f4824/tryon_button',
    )
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
    expect(html).toContain('href="/app"')
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

  // Minor-9 coverage gap: the loader URL and TopLevelAdminAction's onClick
  // behavior each already have their own test, but nothing previously
  // proved they're actually WIRED to each other here -- a typo'd prop name
  // (e.g. passing the wrong variable as `href`) would render an
  // indistinguishable icon="external" button and ship silently. This calls
  // the route component directly (bypassing SSR, which can't observe a
  // click handler's closed-over value) and fires every theme-editor
  // action's onClick to prove each one actually calls window.open with the
  // loader's own themeEditorUrl.
  it('joins the loader theme URL to what each theme-editor action actually navigates to', () => {
    const themeUrl = 'https://admin.shopify.com/store/help-recovery/themes/current/editor?template=product'
    routeState.loaderData = { themeEditorUrl: themeUrl }

    const tree = HelpPage()
    const externalButtons = findAllElements(tree, (node) => (
      node.type === 's-button' && node.props.icon === 'external'
    ))

    expect(externalButtons.length).toBeGreaterThanOrEqual(2)

    const open = vi.fn()
    vi.stubGlobal('window', { open })
    for (const button of externalButtons) button.props.onClick()
    vi.unstubAllGlobals()

    expect(open).toHaveBeenCalledTimes(externalButtons.length)
    for (const call of open.mock.calls) {
      expect(call).toEqual([themeUrl, '_top'])
    }
  })
})
