import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import WorkspaceGuide from '../app/components/WorkspaceGuide.jsx'
import WorkspaceFilters from '../app/components/WorkspaceFilters.jsx'
import ProductOperationsList, {
  filterWorkspaceMappings,
  primaryActionFor,
} from '../app/components/ProductOperationsList.jsx'
import { workspaceGuide } from '../app/workspace.server.js'

global.React = React

const workspaceCss = readFileSync(new URL('../app/styles/workspace.css', import.meta.url), 'utf8')

function extractCssBlock(css, prelude) {
  const preludeIndex = css.indexOf(prelude)
  if (preludeIndex < 0) throw new Error(`Missing CSS block: ${prelude}`)
  const openingBrace = css.indexOf('{', preludeIndex + prelude.length)
  if (openingBrace < 0) throw new Error(`Missing opening brace: ${prelude}`)

  let depth = 1
  for (let index = openingBrace + 1; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    if (css[index] === '}') depth -= 1
    if (depth === 0) return css.slice(openingBrace + 1, index)
  }
  throw new Error(`Missing closing brace: ${prelude}`)
}

function findElements(node, type) {
  if (!node || typeof node !== 'object') return []
  if (typeof node.type === 'function') return findElements(node.type(node.props), type)

  const matches = node.type === type ? [node] : []
  const children = Array.isArray(node.props?.children)
    ? node.props.children
    : [node.props?.children]
  return matches.concat(children.flat(Infinity).flatMap((child) => findElements(child, type)))
}

function buttonWithLabel(node, label) {
  return findElements(node, 's-button').find((button) => button.props.children === label)
}

const rows = [
  {
    id: 'live',
    status: 'live',
    product: { title: 'Willow', imageUrl: 'https://cdn.example/willow.jpg', imageAlt: 'Willow glasses' },
    modelAsset: { displayName: 'Clear' },
  },
  {
    id: 'model',
    status: 'model-issue',
    product: { title: 'Gripz', imageUrl: null },
    modelAsset: { originalFilename: 'Black.glb' },
  },
  {
    id: 'theme',
    status: 'add-to-theme',
    product: { title: 'Lumen', imageUrl: null },
    modelAsset: { displayName: 'Tortoise' },
    themeUrl: 'https://admin.shopify.com/themes/current/editor?previewPath=%2Fproducts%2Flumen',
  },
]

describe('workspace filtering and contextual actions', () => {
  it('combines status and case-insensitive product or model search without reordering rows', () => {
    expect(filterWorkspaceMappings(rows, { status: 'needs-attention', query: 'BLACK' }).map((row) => row.id))
      .toEqual(['model'])
    expect(filterWorkspaceMappings(rows, { status: 'all', query: 'l' }).map((row) => row.id))
      .toEqual(['live', 'model', 'theme'])
    expect(filterWorkspaceMappings(rows, { status: 'live', query: 'tortoise' }))
      .toEqual([])
  })

  it('selects exactly one recovery action and receives pricing from page state', () => {
    expect(primaryActionFor(rows[0], '/plans')).toEqual({ id: 'preview', label: 'Preview' })
    expect(primaryActionFor(rows[1], '/plans')).toEqual({ id: 'choose-model', label: 'Choose model' })
    expect(primaryActionFor(rows[2], '/plans')).toEqual({
      id: 'theme',
      label: 'Add to theme',
      href: rows[2].themeUrl,
    })
    expect(primaryActionFor({ id: 'limited', status: 'plan-limit', usage: { pricingUrl: '/wrong' } }, '/plans'))
      .toEqual({ id: 'plans', label: 'View plans', href: '/plans' })
    expect(primaryActionFor({ id: 'limited', status: 'plan-limit' }, null)).toBeNull()
    expect(primaryActionFor({ id: 'unknown', status: 'unexpected' }, '/plans')).toBeNull()
  })
})

describe('workspace component accessibility contracts', () => {
  it('keeps all rendered guide, status, and empty-state copy merchant-safe', () => {
    const readyAsset = { id: 'ready', status: 'ready' }
    const live = { ...rows[0], modelAsset: readyAsset }
    const guides = [
      workspaceGuide({ assets: [], mappings: [], usage: { atLimit: false } }),
      workspaceGuide({ assets: [readyAsset], mappings: [], usage: { atLimit: false } }),
      workspaceGuide({ assets: [readyAsset], mappings: [rows[1]], usage: { atLimit: false } }),
      workspaceGuide({ assets: [readyAsset], mappings: [rows[2]], usage: { atLimit: false } }),
      workspaceGuide({ assets: [readyAsset], mappings: [live], usage: { atLimit: true, pricingUrl: '/plans' } }),
      workspaceGuide({ assets: [readyAsset], mappings: [live], usage: { atLimit: false } }),
    ]
    const rendered = [
      ...guides.map((guide) => renderToStaticMarkup(React.createElement(WorkspaceGuide, { guide, onAction: vi.fn() }))),
      renderToStaticMarkup(React.createElement(ProductOperationsList, {
        mappings: rows,
        pricingUrl: '/plans',
        onPreview: vi.fn(),
        onChangeModel: vi.fn(),
        onRemove: vi.fn(),
      })),
      renderToStaticMarkup(React.createElement(ProductOperationsList, {
        mappings: [],
        totalCount: 0,
        pricingUrl: '/plans',
        onPreview: vi.fn(),
        onChangeModel: vi.fn(),
        onRemove: vi.fn(),
      })),
      renderToStaticMarkup(React.createElement(ProductOperationsList, {
        mappings: [],
        totalCount: 3,
        pricingUrl: '/plans',
        onPreview: vi.fn(),
        onChangeModel: vi.fn(),
        onRemove: vi.fn(),
      })),
    ].join(' ')

    expect(rendered).toContain('No products match these filters')
    expect(guides.map((guide) => [guide.kind, guide.action?.id ?? null])).toEqual([
      ['setup', 'add-try-on'],
      ['setup', 'add-try-on'],
      ['recovery', 'choose-model'],
      ['recovery', 'theme'],
      ['recovery', 'plans'],
      ['complete', null],
    ])
    expect(rendered).not.toMatch(/metafields?|GLB parsing|storage keys?|GraphQL|render pipelines?/i)
  })

  it('labels search, overflow controls, and product images', () => {
    const filters = renderToStaticMarkup(React.createElement(WorkspaceFilters, {
      counts: { all: 3, live: 1, needsAttention: 2 },
      status: 'all',
      query: '',
      onStatusChange: vi.fn(),
      onQueryChange: vi.fn(),
    }))
    const list = renderToStaticMarkup(React.createElement(ProductOperationsList, {
      mappings: rows,
      pricingUrl: '/plans',
      onPreview: vi.fn(),
      onChangeModel: vi.fn(),
      onRemove: vi.fn(),
    }))

    expect(filters).toContain('aria-label="Search products and models"')
    expect(list).toContain('alt="Willow glasses"')
    expect(list).toContain('accessibilityLabel="Actions for Willow"')
    expect(list).toContain('accessibilityLabel="Actions for Gripz"')
    expect(list).toContain('accessibilityLabel="Actions for Lumen"')
  })

  it('keeps focus visible, narrow rows stacked, filters scrollable, and motion reduced', () => {
    const narrow = extractCssBlock(workspaceCss, '@media (max-width: 640px)')
    const summary = extractCssBlock(narrow, '.workspace-summary')
    const row = extractCssBlock(narrow, '.workspace-row')
    const modelAndStatus = extractCssBlock(narrow, '.workspace-row > :nth-child(2),\n  .workspace-row > :nth-child(3)')
    const action = extractCssBlock(narrow, '.workspace-row > :last-child')
    const reducedMotion = extractCssBlock(workspaceCss, '@media (prefers-reduced-motion: reduce)')
    const reducedWorkspace = extractCssBlock(reducedMotion, '.workspace-shell *,\n  .workspace-shell *::before,\n  .workspace-shell *::after')

    expect(summary).toMatch(/overflow-x:\s*auto/)
    expect(row).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) auto/)
    expect(modelAndStatus).toMatch(/grid-column:\s*1 \/ -1/)
    expect(action).toMatch(/grid-column:\s*2/)
    expect(action).toMatch(/grid-row:\s*1/)
    expect(action).not.toMatch(/display:\s*none|visibility:\s*hidden/)
    expect(workspaceCss).toContain(':focus-visible')
    expect(reducedWorkspace).toMatch(/scroll-behavior:\s*auto\s*!important/)
    expect(reducedWorkspace).toMatch(/transition-duration:\s*0\.01ms\s*!important/)
    expect(reducedWorkspace).toMatch(/animation-duration:\s*0\.01ms\s*!important/)
    expect(reducedWorkspace).toMatch(/animation-iteration-count:\s*1\s*!important/)
  })

  it('distinguishes first-run setup from a filter with no matches', () => {
    const firstRun = renderToStaticMarkup(React.createElement(ProductOperationsList, {
      mappings: [],
      totalCount: 0,
      pricingUrl: '/plans',
      onPreview: vi.fn(),
      onChangeModel: vi.fn(),
      onRemove: vi.fn(),
    }))
    const filtered = renderToStaticMarkup(React.createElement(ProductOperationsList, {
      mappings: [],
      totalCount: 3,
      pricingUrl: '/plans',
      onPreview: vi.fn(),
      onChangeModel: vi.fn(),
      onRemove: vi.fn(),
    }))

    expect(firstRun).toContain('Add try-on to your first product')
    expect(firstRun).not.toContain('No products match')
    expect(filtered).toContain('No products match these filters')
  })
  it('exposes pressed summary buttons and a labelled product and model search', () => {
    const html = renderToStaticMarkup(React.createElement(WorkspaceFilters, {
      counts: { all: 3, live: 1, needsAttention: 2 },
      status: 'needs-attention',
      query: 'black',
      onStatusChange: vi.fn(),
      onQueryChange: vi.fn(),
    }))

    expect(html.match(/<button/g)).toHaveLength(3)
    expect(html).toContain('role="group"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-label="Search products and models"')
    expect(html).toContain('value="black"')
  })

  it('reports the exact selected status and search value', () => {
    const onStatusChange = vi.fn()
    const onQueryChange = vi.fn()
    const filters = WorkspaceFilters({
      counts: { all: 3, live: 1, needsAttention: 2 },
      status: 'all',
      query: '',
      onStatusChange,
      onQueryChange,
    })

    const buttons = findElements(filters, 'button')
    buttons[2].props.onClick()
    findElements(filters, 's-text-field')[0].props.onInput({
      currentTarget: { value: 'Black frame' },
    })

    expect(onStatusChange).toHaveBeenCalledWith('needs-attention')
    expect(onQueryChange).toHaveBeenCalledWith('Black frame')
  })

  it('renders completed guidance as a slim status row with no action', () => {
    const html = renderToStaticMarkup(React.createElement(WorkspaceGuide, {
      guide: { kind: 'complete', title: 'Everything is live', detail: '3 products are ready', action: null },
      onAction: vi.fn(),
    }))

    expect(html).toContain('Everything is live')
    expect(html).toContain('3 products are ready')
    expect(html).toContain('tone="success"')
    expect(html).not.toContain('<s-button')
    expect(html).not.toContain('workspace-guide-panel')
  })

  it('dispatches guide button actions and preserves external destinations', () => {
    const onSetupAction = vi.fn()
    const setupAction = { id: 'add-try-on', label: 'Add try-on' }
    const setup = WorkspaceGuide({
      guide: { kind: 'setup', title: 'Start', detail: 'Choose a product', action: setupAction },
      onAction: onSetupAction,
    })
    buttonWithLabel(setup, 'Add try-on').props.onClick()
    expect(onSetupAction).toHaveBeenCalledWith(setupAction)

    const onRecoveryAction = vi.fn()
    const recoveryAction = { id: 'plans', label: 'View plans', href: '/plans' }
    const recovery = WorkspaceGuide({
      guide: { kind: 'recovery', title: 'Plan limit', detail: 'Upgrade to add more', action: recoveryAction },
      onAction: onRecoveryAction,
    })
    const recoveryButton = buttonWithLabel(recovery, 'View plans')
    recoveryButton.props.onClick()
    expect(recoveryButton.props.href).toBe('/plans')
    expect(recoveryButton.props.target).toBe('_top')
    expect(onRecoveryAction).toHaveBeenCalledWith(recoveryAction)
  })

  it('dispatches primary preview and model actions with the exact mapping', () => {
    const onPreview = vi.fn()
    const onChangeModel = vi.fn()
    const list = ProductOperationsList({
      mappings: [rows[0], rows[1]],
      pricingUrl: '/plans',
      onPreview,
      onChangeModel,
      onRemove: vi.fn(),
    })

    buttonWithLabel(list, 'Preview').props.onClick()
    buttonWithLabel(list, 'Choose model').props.onClick()

    expect(onPreview).toHaveBeenCalledWith(rows[0])
    expect(onChangeModel).toHaveBeenCalledWith(rows[1])
  })

  it('links plan-limit recovery only to page pricing and never changes the model', () => {
    const mapping = {
      id: 'limited',
      status: 'plan-limit',
      product: { title: 'Cedar', imageUrl: null },
      modelAsset: { displayName: 'Smoke' },
    }
    const onChangeModel = vi.fn()
    const withPricing = ProductOperationsList({
      mappings: [mapping],
      pricingUrl: '/plans',
      onPreview: vi.fn(),
      onChangeModel,
      onRemove: vi.fn(),
    })
    const plansLink = buttonWithLabel(withPricing, 'View plans')
    expect(plansLink.props.href).toBe('/plans')
    expect(plansLink.props.target).toBe('_top')
    expect(plansLink.props.onClick).toBeUndefined()

    const withoutPricing = ProductOperationsList({
      mappings: [mapping],
      pricingUrl: null,
      onPreview: vi.fn(),
      onChangeModel,
      onRemove: vi.fn(),
    })
    const unavailableAction = buttonWithLabel(withoutPricing, 'View plans')
    unavailableAction?.props.onClick?.()

    expect(buttonWithLabel(withoutPricing, 'View plans')).toBeUndefined()
    expect(renderToStaticMarkup(withoutPricing)).toContain('>Plan limit<')
    expect(onChangeModel).not.toHaveBeenCalled()
  })

  it('keeps status textual, labels missing product imagery, and limits every overflow menu', () => {
    const html = renderToStaticMarkup(React.createElement(ProductOperationsList, {
      mappings: rows,
      pricingUrl: '/plans',
      onPreview: vi.fn(),
      onChangeModel: vi.fn(),
      onRemove: vi.fn(),
    }))

    expect(html).toContain('alt="Willow glasses"')
    expect(html).toContain('aria-label="No image available for Gripz"')
    expect(html).toContain('>Live<')
    expect(html).toContain('>Model issue<')
    expect(html).toContain('>Add to theme<')
    expect(html.match(/<s-menu/g)).toHaveLength(3)
    const menuLabels = [...html.matchAll(/<s-menu[^>]*>(.*?)<\/s-menu>/g)]
      .map(([, menu]) => [...menu.matchAll(/<s-button[^>]*>(.*?)<\/s-button>/g)]
        .map(([, label]) => label))
    expect(menuLabels).toEqual([
      ['Preview', 'Change model', 'Remove try-on'],
      ['Preview', 'Change model', 'Remove try-on'],
      ['Preview', 'Change model', 'Remove try-on'],
    ])
    expect(html.match(/>Preview<\/s-button>/g)).toHaveLength(4)
    expect(html.match(/>Choose model<\/s-button>/g)).toHaveLength(1)
    expect(html.match(/>Change model<\/s-button>/g)).toHaveLength(3)
    expect(html.match(/>Remove try-on<\/s-button>/g)).toHaveLength(3)
    expect(html).not.toContain('View plans</s-button>')
  })
})
