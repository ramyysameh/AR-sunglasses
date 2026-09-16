import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import WorkspaceGuide from '../app/components/WorkspaceGuide.jsx'
import WorkspaceFilters from '../app/components/WorkspaceFilters.jsx'
import ProductOperationsList, {
  filterWorkspaceMappings,
  primaryActionFor,
} from '../app/components/ProductOperationsList.jsx'

global.React = React

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
