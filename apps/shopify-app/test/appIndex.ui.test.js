import { readFile } from 'node:fs/promises'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import SetupGuide, { buildSetupSteps, nextSetupAction } from '../app/components/SetupGuide.jsx'

global.React = React

// Isolated mocks for the Index-component describe block below, which
// imports the actual route module (not just its pure helpers) to exercise
// the "_top" primary-action branch -- previously untested. Mocked the same
// way appProducts.ui.test.js/appModels.ui.test.js mock their own route's
// dependencies, so importing the module doesn't touch the real DB or
// require live Shopify env vars.
const routeState = vi.hoisted(() => ({ loaderData: null }))
vi.mock('react-router', () => ({
  useLoaderData: () => routeState.loaderData,
}))
vi.mock('@shopify/shopify-app-react-router/server', () => ({
  boundary: { headers: vi.fn() },
}))
vi.mock('../app/shopify.server.js', () => ({ authenticate: { admin: vi.fn() } }))
vi.mock('../app/db.server.js', () => ({ default: {} }))

const { default: Index } = await import('../app/routes/app._index.jsx')

const routeUrl = new URL('../app/routes/app._index.jsx', import.meta.url)
const setupGuideUrl = new URL('../app/components/SetupGuide.jsx', import.meta.url)

describe('home Polaris contract', () => {
  it('uses valid subdued text and numeric ARIA values', async () => {
    const source = await readFile(routeUrl, 'utf8')
    expect(source).not.toContain('tone="subdued"')
    expect(source).not.toContain('aria-valuemin="0"')
    expect(source).toContain('color="subdued"')
    expect(source).toContain('aria-valuemin={0}')
    // Minor-5: this is the file the #e3e3e3/#008060 progress bar literally
    // lived in before the Polaris pass replaced it with token-driven
    // colors -- the hex guard below was added to SetupGuide.jsx (once that
    // component owned the markup) but never backfilled here, leaving the
    // one file that actually had the regression unpinned.
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  // SetupGuide.jsx now owns the setup-guide markup that used to live inline
  // in app._index.jsx, so the same contract (no literal hex colors, no
  // tone="subdued" misuse) must hold there too.
  it('keeps SetupGuide.jsx free of literal colors and tone="subdued" misuse', async () => {
    const source = await readFile(setupGuideUrl, 'utf8')
    expect(source).not.toContain('tone="subdued"')
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})

describe('setup guide next action', () => {
  it.each([
    [{ modelCount: 0, mappingCount: 0, liveCount: 0 }, 'Upload model', '/app/models'],
    [{ modelCount: 1, mappingCount: 0, liveCount: 0 }, 'Add try-on', '/app/products'],
    [{ modelCount: 1, mappingCount: 1, liveCount: 0 }, 'Add to theme', 'https://admin.shopify.com/theme'],
    [{ modelCount: 1, mappingCount: 1, liveCount: 1 }, 'Manage products', '/app/products'],
  ])('chooses the next useful action for %j', (counts, label, href) => {
    const steps = buildSetupSteps({ ...counts, themeUrl: 'https://admin.shopify.com/theme' })
    expect(nextSetupAction(steps)).toMatchObject({ actionLabel: label, href })
  })
})

describe('SetupGuide rendering', () => {
  it('gives every incomplete step an action, marks completed steps Done, and reports progress', () => {
    const html = renderToStaticMarkup(
      React.createElement(SetupGuide, {
        modelCount: 1,
        mappingCount: 0,
        liveCount: 0,
        themeUrl: 'https://admin.shopify.com/theme',
      }),
    )

    // Progress copy.
    expect(html).toContain('1 out of 3 steps completed.')

    // Completed step (model) is compact and marked Done.
    expect(html).toContain('Done')

    // Both incomplete steps (product, theme) still offer an action. The
    // product step's own label ("Add try-on to a product") already contains
    // the substring "Add try-on", so a plain `toContain('Add try-on')` would
    // pass even if its button were never rendered. Assert the label and the
    // button separately: the button check requires an <s-button> whose only
    // content is exactly "Add try-on", which only the button itself matches
    // (the label has trailing text, and accessibilityLabel is an attribute
    // value, not element content, so neither can satisfy this pattern).
    expect(html).toContain('Add try-on to a product')
    expect(html).toMatch(/<s-button[^>]*>Add try-on<\/s-button>/)
    expect(html).toContain('Add to theme')

    // No decorative disabled checkboxes standing in for status.
    expect(html).not.toMatch(/<input[^>]*type="checkbox"/)
  })

  it('marks every step Done once the guide is fully complete, but keeps the theme action reachable', () => {
    const html = renderToStaticMarkup(
      React.createElement(SetupGuide, {
        modelCount: 2,
        mappingCount: 3,
        liveCount: 1,
        themeUrl: 'https://admin.shopify.com/theme',
      }),
    )

    expect(html).toContain('3 out of 3 steps completed.')
    expect(html.match(/Done/g)).toHaveLength(3)

    // liveCount > 0 only means the block has been seen once -- it is not
    // proof the block is still installed, so the theme step must keep its
    // action even after it is marked Done (regression guard for a merchant
    // whose block was later removed from the theme).
    expect(html).toContain('Manage in theme editor')
  })

  // Important-1 fix: SetupGuide's own per-step theme action used to render
  // <s-button href target="_top">, the exact pattern TopLevelAdminAction.jsx
  // documents as unreliable (App Bridge can intercept navigation from a
  // Polaris s-* component's href/target). Called directly (SetupGuide has no
  // hooks) so the actual element -- not just its rendered text -- can be
  // inspected: icon="external", no href/target attribute, and an onClick
  // that opens the loader's themeUrl at the top level.
  it('gives the theme step action TopLevelAdminAction (icon="external", no href) instead of href+target="_top"', () => {
    const themeUrl = 'https://admin.shopify.com/theme'
    const tree = SetupGuide({
      modelCount: 1,
      mappingCount: 1,
      liveCount: 0,
      themeUrl,
    })
    const themeButton = findAllElements(tree, (node) => (
      node.type === 's-button' && node.props.accessibilityLabel === 'Add to theme'
    ))[0]

    expect(themeButton).toBeTruthy()
    expect(themeButton.props.icon).toBe('external')
    expect(themeButton.props.href).toBeUndefined()
    expect(themeButton.props.target).toBeUndefined()

    const open = vi.fn()
    vi.stubGlobal('window', { open })
    themeButton.props.onClick()
    vi.unstubAllGlobals()
    expect(open).toHaveBeenCalledWith(themeUrl, '_top')
  })
})

// Walks a returned React element tree, expanding function-component nodes
// (e.g. <TopLevelAdminAction .../>) since a tree built by calling a
// component directly (not through React's renderer) never reconciles child
// components on its own -- same helper as appAdditional.test.js's
// findAllElements, needed here for the same reason.
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

// Minor-9 coverage gap: app._index.jsx's "_top" primary-action branch
// (TopLevelAdminAction when the next setup step is the theme step) had no
// test at all before this. Calling Index() directly (react-router mocked
// above) lets us inspect the actual rendered primary action instead of just
// trusting buildSetupSteps/nextSetupAction's return shape.
describe('Index primary action', () => {
  const baseUsage = { planName: 'Starter', used: 1, limit: 10, unlimited: false, atLimit: false, pricingUrl: null }

  it('uses TopLevelAdminAction (icon="external", no href/target on the button) when the theme step is next', () => {
    const themeUrl = 'https://admin.shopify.com/store/x/themes/current/editor?template=product'
    routeState.loaderData = {
      modelCount: 1,
      mappingCount: 1,
      liveCount: 0,
      usage: baseUsage,
      themeUrl,
    }

    const tree = Index()
    const primary = findAllElements(tree, (node) => (
      node.type === 's-button' && node.props.slot === 'primary-action'
    ))[0]

    expect(primary).toBeTruthy()
    expect(primary.props.icon).toBe('external')
    expect(primary.props.href).toBeUndefined()
    expect(primary.props.target).toBeUndefined()

    const open = vi.fn()
    vi.stubGlobal('window', { open })
    primary.props.onClick()
    vi.unstubAllGlobals()
    expect(open).toHaveBeenCalledWith(themeUrl, '_top')
  })

  it('stays a plain in-app <s-button href> (no onClick/window.open) when a non-theme step is next', () => {
    routeState.loaderData = {
      modelCount: 0,
      mappingCount: 0,
      liveCount: 0,
      usage: baseUsage,
      themeUrl: 'https://admin.shopify.com/store/x/themes/current/editor?template=product',
    }

    const tree = Index()
    const primary = findAllElements(tree, (node) => (
      node.type === 's-button' && node.props.slot === 'primary-action'
    ))[0]

    expect(primary).toBeTruthy()
    expect(primary.props.href).toBe('/app/models')
    expect(primary.props.icon).toBeUndefined()
    expect(primary.props.onClick).toBeUndefined()
  })
})
