import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PreviewPanel from '../app/components/PreviewPanel.jsx'

const routeState = vi.hoisted(() => ({ loaderData: null }))

vi.mock('react-router', () => ({
  useLoaderData: () => routeState.loaderData,
  useFetcher: () => ({ data: null, state: 'idle', submit: vi.fn() }),
}))
vi.mock('@shopify/app-bridge-react', () => ({
  useAppBridge: () => ({ resourcePicker: vi.fn(), toast: { show: vi.fn() } }),
}))
vi.mock('@shopify/shopify-app-react-router/server', () => ({
  boundary: { headers: vi.fn() },
}))
vi.mock('../app/shopify.server.js', () => ({ authenticate: { admin: vi.fn() } }))
vi.mock('../app/db.server.js', () => ({ default: {} }))
vi.mock('../app/components/ModelViewer.jsx', () => ({
  default: ({ src, alt }) => React.createElement('div', { 'data-model-src': src, 'data-model-alt': alt }),
}))

global.React = React

const {
  default: Products,
  mappingModalReducer,
  mappingSubmitDisabled,
} = await import('../app/routes/app.products.jsx')
const { default: ModelPicker } = await import('../app/components/ModelPicker.jsx')

const assets = [
  { id: 'model-a', label: 'Aviator' },
  { id: 'model-b', label: 'Wayfarer' },
]

function mapping(id, modelAssetId = 'model-a') {
  return {
    id,
    productId: `gid://shopify/Product/${id}`,
    modelAssetId,
    modelAsset: assets.find((asset) => asset.id === modelAssetId),
    product: { title: `Product ${id}`, handle: `product-${id}`, imageUrl: null, imageAlt: null },
    status: { id: 'live', label: 'Live', tone: 'success' },
    previewUrl: `https://preview.example/${id}`,
    qr: null,
    themeUrl: `https://admin.shopify.com/theme?previewPath=%2Fproducts%2Fproduct-${id}`,
  }
}

beforeEach(() => {
  routeState.loaderData = {
    mappings: [mapping('mapping-1'), mapping('mapping-2', 'model-b')],
    assets,
    usage: {
      planName: 'Starter',
      used: 10,
      limit: 10,
      unlimited: false,
      atLimit: true,
      pricingUrl: 'https://admin.shopify.com/pricing',
    },
    themeUrl: 'https://admin.shopify.com/theme',
  }
})

describe('ModelPicker', () => {
  it('uses a controlled choice list and reports the selected model', () => {
    const onChange = vi.fn()
    const picker = ModelPicker({ assets, value: 'model-b', onChange })

    expect(picker.type).toBe('s-choice-list')
    expect(picker.props.values).toEqual(['model-b'])

    picker.props.onChange({ currentTarget: { values: ['model-a'] } })
    expect(onChange).toHaveBeenCalledWith('model-a')
  })
})

describe('Products working surface', () => {
  it('previews the glasses model without composing it onto a mock head', () => {
    const html = renderToStaticMarkup(React.createElement(PreviewPanel, { mapping: mapping('preview') }))
    expect(html).toContain('data-model-src="/models/model-a.glb"')
    expect(html).not.toContain('fit-preview.glb')
    expect(html).not.toMatch(/reference head/i)
  })
  it('starts a fresh modal session when the same mapping is reopened after dismissal', () => {
    const initial = { mappingId: null, session: 0 }
    const opened = mappingModalReducer(initial, { type: 'open', mappingId: 'mapping-1' })
    const dismissed = mappingModalReducer(opened, { type: 'dismiss' })
    const reopened = mappingModalReducer(dismissed, { type: 'open', mappingId: 'mapping-1' })

    expect(opened.mappingId).toBe('mapping-1')
    expect(dismissed.mappingId).toBeNull()
    expect(reopened.mappingId).toBe('mapping-1')
    expect(reopened.session).not.toBe(opened.session)
  })

  it('keeps a publish retry enabled without opening the plan limit to new products', () => {
    const retryResult = {
      retryable: true,
      productId: 'gid://shopify/Product/retry',
      modelAssetId: 'model-a',
    }

    expect(mappingSubmitDisabled({
      productId: 'gid://shopify/Product/retry',
      modelAssetId: 'model-a',
      currentModelAssetId: 'model-a',
      atLimit: true,
      result: retryResult,
    })).toBe(false)

    expect(mappingSubmitDisabled({
      productId: 'gid://shopify/Product/new',
      modelAssetId: 'model-a',
      currentModelAssetId: null,
      atLimit: true,
      result: retryResult,
    })).toBe(true)
  })

  it('disables adding at the plan limit without disabling model changes', () => {
    expect(mappingSubmitDisabled({
      productId: 'gid://shopify/Product/new',
      modelAssetId: 'model-a',
      atLimit: true,
    })).toBe(true)
    expect(mappingSubmitDisabled({
      productId: 'gid://shopify/Product/mapped',
      modelAssetId: 'model-b',
      currentModelAssetId: 'model-a',
      atLimit: true,
    })).toBe(false)
  })

  it('routes product actions to one shared change modal and one shared remove modal', () => {
    const html = renderToStaticMarkup(React.createElement(Products))
    const targets = [...html.matchAll(/commandFor="([^"]+)"/g)].map((match) => match[1])
    const uniqueTargets = new Set(targets)

    expect(html.match(/id="change-model"/g)).toHaveLength(1)
    expect(html.match(/id="remove-tryon"/g)).toHaveLength(1)
    expect(html).not.toMatch(/id="change-model-mapping-/)
    expect(html).not.toMatch(/id="remove-tryon-mapping-/)

    for (const target of uniqueTargets) {
      const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      expect(html.match(new RegExp(`id="${escapedTarget}"`, 'g'))).toHaveLength(1)
    }
  })

  it('opens Add to theme on the selected product page', () => {
    routeState.loaderData.mappings = [{
      ...mapping('selected'),
      status: { id: 'not_on_theme', label: 'Not on theme', tone: 'warning' },
    }]
    const html = renderToStaticMarkup(React.createElement(Products))
    expect(html).toContain('previewPath=%2Fproducts%2Fproduct-selected')
    expect(html).toContain('<s-button')
    expect(html).toContain('variant="primary"')
    expect(html).toContain('icon="external"')
  })

  it('uses legacy status objects consistently for counts, badges, and actions', () => {
    routeState.loaderData.mappings = [
      mapping('live'),
      {
        ...mapping('theme'),
        status: { id: 'not_on_theme', label: 'Not on theme', tone: 'warning' },
      },
    ]

    const html = renderToStaticMarkup(React.createElement(Products))
    expect(html).toContain('1 live, 1 needs attention')
    expect(html).toContain('>Live</s-badge>')
    expect(html).toContain('>Not on theme</s-badge>')
    expect(html).toContain('previewPath=%2Fproducts%2Fproduct-theme')
  })
})
