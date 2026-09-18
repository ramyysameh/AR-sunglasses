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
const { default: ModelPicker, filterModelAssets, ModelPickerView } = await import('../app/components/ModelPicker.jsx')

// Walks a returned React element tree (plain objects with .type/.props, as
// returned by calling a hook-free component function directly) looking for
// the first element matching `predicate` -- same helper as productIndex.ui.test.js.
function findElement(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  const children = node.props?.children
  if (children === undefined) return null
  const list = Array.isArray(children) ? children : [children]
  for (const child of list) {
    const found = findElement(child, predicate)
    if (found) return found
  }
  return null
}

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
  // Brief's Step 1 assertion, verbatim. The SSR assertion relies on
  // ModelViewer mounting the real <model-viewer> custom element only after
  // intersection + a dynamic import that never resolves during SSR, so
  // "Loading 3D preview" (ModelViewer's spinner accessibilityLabel) stands
  // in as a per-instance marker: exactly one means exactly one ModelViewer
  // was mounted, for the selected asset only, never one per choice.
  it('filters model names without mounting one viewer per choice', () => {
    expect(filterModelAssets(assets, 'way')).toEqual([assets[1]])
    const html = renderToStaticMarkup(
      React.createElement(ModelPicker, { assets, value: 'model-b', onChange: vi.fn() }),
    )
    expect(html).toContain('s-search-field')
    expect(html.match(/<model-viewer/g) ?? []).toHaveLength(0)
    expect(html.match(/Loading 3D preview/g)).toHaveLength(1)
  })

  it('is case-insensitive and returns every asset for an empty query', () => {
    expect(filterModelAssets(assets, 'WAY')).toEqual([assets[1]])
    expect(filterModelAssets(assets, '')).toEqual(assets)
    expect(filterModelAssets(assets, '   ')).toEqual(assets)
    expect(filterModelAssets(assets, 'zzz')).toEqual([])
  })

  it('binds the search field and choice list with onInput, not onChange (React 18 dispatch)', () => {
    // React 18's ChangeEventPlugin only special-cases native <select>/<input
    // type=file> when deciding whether to dispatch a synthetic `change`
    // event -- an arbitrary custom element never qualifies, so onChange here
    // would silently never fire (this was true of s-choice-list's
    // pre-existing onChange before this task). `input` is a simple,
    // type-agnostic DOM event React forwards regardless of tag name.
    const tree = ModelPickerView({
      assets,
      filtered: assets,
      value: 'model-b',
      query: '',
      onQueryChange: vi.fn(),
      onChoiceChange: vi.fn(),
      onClearSearch: vi.fn(),
    })
    const searchField = findElement(tree, (node) => node.type === 's-search-field')
    const choiceList = findElement(tree, (node) => node.type === 's-choice-list')

    expect(typeof searchField.props.onInput).toBe('function')
    expect(searchField.props.onChange).toBeUndefined()
    expect(typeof choiceList.props.onInput).toBe('function')
    expect(choiceList.props.onChange).toBeUndefined()
  })

  it('reports the selected model through the onChange prop when a choice fires input', () => {
    const onChange = vi.fn()
    const tree = ModelPickerView({
      assets,
      filtered: assets,
      value: 'model-b',
      query: '',
      onQueryChange: vi.fn(),
      onChoiceChange: onChange,
      onClearSearch: vi.fn(),
    })
    const choiceList = findElement(tree, (node) => node.type === 's-choice-list')

    choiceList.props.onInput({ currentTarget: { values: ['model-a'] } })
    expect(onChange).toHaveBeenCalledWith('model-a')
  })

  it('keeps the search field visible and offers Clear search when nothing matches', () => {
    const onClearSearch = vi.fn()
    const html = renderToStaticMarkup(
      React.createElement('div', null, ModelPickerView({
        assets,
        filtered: [],
        value: 'model-b',
        query: 'zzz',
        onQueryChange: vi.fn(),
        onChoiceChange: vi.fn(),
        onClearSearch,
      })),
    )

    expect(html).toContain('s-search-field')
    expect(html).toContain('>No models match your search<')
    expect(html).toMatch(/>Clear search</)

    const tree = ModelPickerView({
      assets,
      filtered: [],
      value: 'model-b',
      query: 'zzz',
      onQueryChange: vi.fn(),
      onChoiceChange: vi.fn(),
      onClearSearch,
    })
    const clearButton = findElement(tree, (node) => (
      node.type === 's-button' && node.props.children === 'Clear search'
    ))

    expect(clearButton).toBeTruthy()
    clearButton.props.onClick()
    expect(onClearSearch).toHaveBeenCalledTimes(1)
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

  // Pins the route -> ProductIndex wiring itself. Without this, the
  // commandFor/id invariant test above would still pass even if ProductIndex
  // were accidentally left unmounted (it asserts "no orphans", not "the
  // index renders at all") -- and every dead-end-state test in this file
  // uses mappings: [], which never reaches the ProductIndex branch either.
  it('renders the product index with its filters when mappings exist', () => {
    const html = renderToStaticMarkup(React.createElement(Products))

    expect(html).toContain('slot="filters"')
    expect(html).toContain('s-search-field')
    expect(html).toContain('commandFor="preview-mapping-1"')
    expect(html).toContain('id="preview-mapping-1"')
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
