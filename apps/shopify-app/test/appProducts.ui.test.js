import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

global.React = React

const {
  default: Products,
  mappingModalReducer,
  mappingSubmitDisabled,
  productPrimaryAction,
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
    product: { title: `Product ${id}`, imageUrl: null, imageAlt: null },
    status: { id: 'live', label: 'Live', tone: 'success' },
    previewUrl: `https://preview.example/${id}`,
    qr: null,
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
})

describe('productPrimaryAction', () => {
  it.each([
    [{ assetCount: 0, usage: { atLimit: false } }, 'upload', 'Upload model'],
    [{ assetCount: 2, usage: { atLimit: false } }, 'add', 'Add try-on'],
    [{ assetCount: 2, usage: { atLimit: true, pricingUrl: 'https://admin.shopify.com/pricing' } }, 'upgrade', 'Upgrade plan'],
  ])('chooses a completable primary action', (input, kind, label) => {
    expect(productPrimaryAction(input)).toMatchObject({ kind, label })
  })
})

describe('Products dead-end states', () => {
  it('shows the true zero-model empty state with no reachable Add try-on modal', () => {
    routeState.loaderData = {
      mappings: [],
      assets: [],
      usage: {
        planName: 'Starter',
        used: 0,
        limit: 10,
        unlimited: false,
        atLimit: false,
        pricingUrl: 'https://admin.shopify.com/pricing',
      },
      themeUrl: 'https://admin.shopify.com/theme',
    }

    const html = renderToStaticMarkup(React.createElement(Products))

    expect(html).toMatch(/Upload model/)
    expect(html).toMatch(/href="\/app\/models"/)
    // Not just "not the primary action" -- the modal must not exist in the
    // tree at all, so there is no way (button, command, or otherwise) to
    // reach a modal that would open onto an empty model picker.
    expect(html).not.toMatch(/commandFor="add-tryon"/)
    expect(html).not.toMatch(/id="add-tryon"/)
    // This is the true zero-model state, not the "models exist but no
    // products mapped yet" state -- conflating the two would still say
    // "Upload model" (from the primary action) even if the section body
    // wrongly showed the mapped-products empty-state copy instead.
    expect(html).not.toMatch(/Add try-on to your first product/)
  })

  it('keeps the mapped-products empty state distinct from the zero-model state', () => {
    routeState.loaderData = {
      mappings: [],
      assets: [{ id: 'model-a', label: 'Aviator' }],
      usage: {
        planName: 'Starter',
        used: 0,
        limit: 10,
        unlimited: false,
        atLimit: false,
        pricingUrl: 'https://admin.shopify.com/pricing',
      },
      themeUrl: 'https://admin.shopify.com/theme',
    }

    const html = renderToStaticMarkup(React.createElement(Products))

    // Models exist, so the real "add a product" path must stay reachable...
    expect(html).toMatch(/Add try-on to your first product/)
    expect(html).toMatch(/commandFor="add-tryon"/)
    // ...and this is NOT the zero-model message.
    expect(html).not.toMatch(/Upload a model to get started/)
  })

  it('offers an upgrade action instead of Add try-on when the plan is at its limit', () => {
    // routeState.loaderData default (beforeEach) already has assets and atLimit: true.
    const html = renderToStaticMarkup(React.createElement(Products))

    expect(html).toMatch(/Upgrade plan/)
    expect(html).not.toMatch(/slot="primary-action"[^>]*commandFor="add-tryon"/)
  })
})
