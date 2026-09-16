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
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-label="Search products and models"')
    expect(html).toContain('value="black"')
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
