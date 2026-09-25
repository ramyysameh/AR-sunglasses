import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspaceGuide from '../app/components/WorkspaceGuide.jsx'
import WorkspaceFilters from '../app/components/WorkspaceFilters.jsx'
import ProductOperationsList, { primaryActionFor } from '../app/components/ProductOperationsList.jsx'
import { AddTryOnFlow } from '../app/components/AddTryOnFlow.jsx'
import TopLevelAdminAction from '../app/components/TopLevelAdminAction.jsx'
import PlanUsage from '../app/components/PlanUsage.jsx'

const harness = vi.hoisted(() => ({
  data: null,
  location: { search: '' },
  revalidate: vi.fn(),
  toast: vi.fn(),
  modalShow: vi.fn(),
  modalHide: vi.fn(),
  fetcher: {
    data: null,
    state: 'idle',
    // eslint-disable-next-line react/prop-types -- lightweight fetcher form double
    Form: ({ children, ...props }) => React.createElement('form', props, children),
  },
  state: [],
  stateIndex: 0,
}))

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal()),
  useCallback: (callback) => callback,
  useRef: (initial) => {
    const index = harness.stateIndex++
    if (harness.state[index] === undefined) harness.state[index] = { current: initial }
    return harness.state[index]
  },
  useState: (initial) => {
    const index = harness.stateIndex++
    if (harness.state[index] === undefined) harness.state[index] = initial
    return [harness.state[index], (value) => {
      harness.state[index] = typeof value === 'function' ? value(harness.state[index]) : value
    }]
  },
}))
vi.mock('react-router', () => ({
  useFetcher: () => harness.fetcher,
  useLoaderData: () => harness.data,
  useLocation: () => harness.location,
  useRevalidator: () => ({ revalidate: harness.revalidate }),
}))
vi.mock('@shopify/app-bridge-react', () => ({
  useAppBridge: () => ({
    toast: { show: harness.toast },
    modal: { show: harness.modalShow, hide: harness.modalHide },
  }),
}))
vi.mock('../app/shopify.server.js', () => ({
  authenticate: { admin: vi.fn() },
}))
vi.mock('../app/productActions.server.js', () => ({
  handleProductAction: vi.fn(),
}))

global.React = React

const {
  default: Workspace,
  initialAddRequest,
  ReviewFitDialog,
} = await import('../app/routes/app._index.jsx')

const readyAsset = { id: 'ready-model', label: 'Ready model', status: 'ready' }

function baseData(overrides = {}) {
  return {
    assets: [readyAsset],
    mappings: [],
    counts: { all: 0, live: 0, needsAttention: 0 },
    usage: { used: 0, limit: 5, atLimit: false, pricingUrl: '/plans' },
    guide: { kind: 'setup', title: 'Add your first product', detail: 'Choose a model.', action: { id: 'add-try-on', label: 'Add try-on' } },
    themeUrl: 'https://shop.test/admin/themes/current/editor?template=product',
    ...overrides,
  }
}

function findElements(node, type) {
  if (!node || typeof node !== 'object') return []
  const matches = node.type === type ? [node] : []
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]
  return matches.concat(children.flat(Infinity).flatMap((child) => findElements(child, type)))
}

function findComponent(node, type) {
  return findElements(node, type)[0]
}

function render(data, search = '') {
  harness.data = data
  harness.location = { search }
  harness.stateIndex = 0
  return Workspace()
}

beforeEach(() => {
  harness.state = []
  harness.stateIndex = 0
  harness.revalidate.mockReset()
  harness.toast.mockReset()
  harness.modalShow.mockReset()
  harness.modalHide.mockReset()
})

describe('Workspace route composition', () => {
  it('renders merchant-safe page and dialog copy', () => {
    const data = baseData({
      mappings: [{
        id: 'issue',
        productId: 'gid://shopify/Product/1',
        status: 'model-issue',
        product: { title: 'Willow' },
        modelAsset: readyAsset,
      }],
      counts: { all: 1, live: 0, needsAttention: 1 },
      guide: {
        kind: 'recovery',
        title: 'A model needs attention',
        detail: 'Willow',
        action: { id: 'choose-model', mappingId: 'issue', label: 'Choose model' },
      },
    })

    harness.data = data
    harness.location = { search: '' }
    harness.stateIndex = 0
    const html = renderToStaticMarkup(React.createElement(Workspace))

    expect(html).toContain('heading="Workspace"')
    expect(html).toContain('A model needs attention')
    expect(html).toContain('heading="Choose a model"')
    expect(html).toContain('heading="Change model for product"')
    expect(html).toContain('heading="Remove try-on from this product?"')
    expect(html).toContain('heading="Preview try-on"')
    expect(html).toContain('>Close</s-button>')
    expect(html).toContain('>Cancel</s-button>')
    expect(html).toContain('>Change model</s-button>')
    expect(html).toContain('>Remove try-on</s-button>')
    expect(html).not.toMatch(/metafields?|GLB parsing|storage keys?|GraphQL|render pipelines?/i)
  })

  it('restores Add try-on focus once when an opened modal finishes hiding', () => {
    const focus = vi.fn()
    const page = render(baseData({
      mappings: [{ id: 'live', status: 'live', product: { title: 'Aviator' }, modelAsset: readyAsset }],
      counts: { all: 1, live: 1, needsAttention: 0 },
    }))
    const trigger = findElements(page, 's-button')
      .find((button) => button.props.slot === 'primary-action')
    const flow = findComponent(page, AddTryOnFlow)
    trigger.ref.current = { focus }

    trigger.props.onClick()
    flow.props.onClose()
    flow.props.onClose()

    expect(harness.state).toContain(false)
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('renders the page-level Add try-on primary only when products exist to manage', () => {
    const page = render(baseData())
    expect(page.type).toBe('s-page')
    expect(page.props.heading).toBe('Workspace')
    const pagePrimaries = findElements(page, 's-button').filter((button) => button.props.slot === 'primary-action')
    expect(pagePrimaries).toHaveLength(0)

    const activePage = render(baseData({
      mappings: [{ id: 'live', status: 'live', product: { title: 'Aviator' }, modelAsset: readyAsset }],
      counts: { all: 1, live: 1, needsAttention: 0 },
    }))
    const activePrimaries = findElements(activePage, 's-button').filter((button) => button.props.slot === 'primary-action')
    expect(activePrimaries).toHaveLength(1)
    expect(activePrimaries[0].props.children).toBe('Add try-on')
    expect(activePrimaries[0].props.commandFor).toBe('add-tryon-flow')
    expect(activePrimaries[0].props.command).toBe('--show')
  })

  it.each([
    ['model issue', {
      id: 'issue',
      status: 'model-issue',
      product: { title: 'Willow' },
      modelAsset: readyAsset,
    }, {
      kind: 'recovery',
      title: 'A model needs attention',
      detail: 'Willow',
      action: { id: 'choose-model', mappingId: 'issue', label: 'Choose model' },
    }],
    ['add to theme', {
      id: 'theme',
      status: 'add-to-theme',
      product: { title: 'Lumen' },
      modelAsset: readyAsset,
      themeUrl: '/theme-editor',
    }, {
      kind: 'recovery',
      title: 'Finish storefront setup',
      detail: 'Lumen',
      action: { id: 'theme', href: '/theme-editor', label: 'Add to theme' },
    }],
  ])('shows a compact plan route beside disabled Add while preserving the %s guide', (_case, mapping, guide) => {
    const page = render(baseData({
      mappings: [mapping],
      counts: { all: 1, live: 0, needsAttention: 1 },
      usage: { used: 1, limit: 1, atLimit: true, pricingUrl: '/plans' },
      guide,
    }))
    const addButton = findElements(page, 's-button')
      .find((candidate) => candidate.props.slot === 'primary-action')
    // The standalone "Your plan limit is reached / View plans" banner this
    // used to assert has been removed: PlanUsage is always present, turns
    // amber at the limit and carries its own Upgrade action, and the guide
    // surfaces the limit too, so the banner was a third route to the same
    // pricing page on one screen. The plan route now lives inside PlanUsage,
    // which this helper does not render into (findElements matches element
    // types without invoking function components), so the route-level
    // contract asserted here is that PlanUsage receives the limit state --
    // planUsage.ui.test.js covers the meter and the Upgrade button it builds
    // from it, including that the button is a TopLevelAdminAction and not an
    // <s-button href target="_top"> App Bridge would intercept.
    const planUsage = findComponent(page, PlanUsage)

    expect(addButton.props.disabled).toBe(true)
    expect(planUsage.props.usage).toMatchObject({ atLimit: true, pricingUrl: '/plans' })
    expect(findComponent(page, TopLevelAdminAction)).toBeUndefined()
    expect(findComponent(page, WorkspaceGuide).props.guide).toEqual(guide)
  })

  it('preselects only a ready model from an add deep link', () => {
    expect(initialAddRequest('?add=1&model=ready-model', [readyAsset])).toEqual({
      open: true,
      modelId: 'ready-model',
    })
    expect(initialAddRequest('?add=1&model=processing', [{ id: 'processing', status: 'processing' }]))
      .toEqual({ open: true, modelId: undefined })
    expect(initialAddRequest('?add=1&model=missing-status', [{ id: 'missing-status' }]))
      .toEqual({ open: true, modelId: undefined })
    expect(initialAddRequest('?add=1&model=unknown', [{ id: 'unknown', status: 'unknown' }]))
      .toEqual({ open: true, modelId: undefined })
    expect(initialAddRequest('?add=1&model=uppercase', [{ id: 'uppercase', status: 'READY' }]))
      .toEqual({ open: true, modelId: 'uppercase' })
    expect(initialAddRequest('?model=ready-model', [readyAsset])).toEqual({ open: false, modelId: undefined })
  })

  it('opens change model for the exact mapping selected by guide recovery', () => {
    const first = { id: 'first', status: 'model-issue', product: { title: 'First' }, modelAsset: readyAsset }
    const selected = { id: 'selected', status: 'model-issue', product: { title: 'Selected' }, modelAsset: readyAsset }
    const data = baseData({
      mappings: [first, selected],
      counts: { all: 2, live: 0, needsAttention: 2 },
      guide: {
        kind: 'recovery',
        title: 'A model needs attention',
        detail: 'Selected',
        action: { id: 'choose-model', mappingId: 'selected', label: 'Choose model' },
      },
    })
    const page = render(data)
    findComponent(page, WorkspaceGuide).props.onAction(data.guide.action)

    expect(harness.state).toContain(selected)
    expect(harness.state).not.toContain(first)
    expect(harness.modalShow).toHaveBeenCalledWith('workspace-change-model')
  })

  it.each([
    ['empty', baseData({ assets: [], guide: { kind: 'setup', title: 'Upload your first model', detail: 'Add a ready-to-use eyewear model.', action: { id: 'add-try-on', label: 'Upload model' } } }), { id: 'add-try-on', label: 'Upload model' }],
    ['live', baseData({ mappings: [{ id: 'live', status: 'live', product: { title: 'Aviator' }, modelAsset: readyAsset }], counts: { all: 1, live: 1, needsAttention: 0 }, guide: { kind: 'complete', title: 'Everything is live', detail: '1 product is ready', action: null } }), { id: 'preview', label: 'Preview' }],
    ['add-to-theme', baseData({ mappings: [{ id: 'theme', status: 'add-to-theme', product: { title: 'Lumen' }, modelAsset: readyAsset, themeUrl: 'https://shop.test/admin/themes/current/editor?previewPath=%2Fproducts%2Flumen&addAppBlockId=key%2Ftryon_button&target=mainSection' }], counts: { all: 1, live: 0, needsAttention: 1 }, guide: { kind: 'recovery', title: 'Finish storefront setup', detail: 'Lumen', action: { id: 'theme', label: 'Add to theme', href: 'https://shop.test/admin/themes/current/editor?previewPath=%2Fproducts%2Flumen&addAppBlockId=key%2Ftryon_button&target=mainSection' } } }), { id: 'theme', label: 'Add to theme', href: 'https://shop.test/admin/themes/current/editor?previewPath=%2Fproducts%2Flumen&addAppBlockId=key%2Ftryon_button&target=mainSection' }],
    ['model-issue', baseData({ mappings: [{ id: 'issue', status: 'model-issue', product: { title: 'Willow' }, modelAsset: readyAsset }], counts: { all: 1, live: 0, needsAttention: 1 }, guide: { kind: 'recovery', title: 'A model needs attention', detail: 'Willow', action: { id: 'choose-model', mappingId: 'issue', label: 'Choose model' } } }), { id: 'choose-model', mappingId: 'issue', label: 'Choose model' }],
    ['plan-limit', baseData({ mappings: [{ id: 'live-limit', status: 'live', product: { title: 'Cedar' }, modelAsset: readyAsset }], counts: { all: 1, live: 1, needsAttention: 0 }, usage: { used: 1, limit: 1, atLimit: true, pricingUrl: '/plans' }, guide: { kind: 'recovery', title: 'Your plan limit is reached', detail: 'Upgrade before adding another product.', action: { id: 'plans', label: 'View plans', href: '/plans' } } }), { id: 'plans', label: 'View plans', href: '/plans' }],
  ])('exposes one merchant-safe contextual primary for %s', (_state, data, expected) => {
    const page = render(data)
    const guideAction = findComponent(page, WorkspaceGuide).props.guide.action
    const list = findComponent(page, ProductOperationsList)
    const rowActions = (list?.props.mappings ?? [])
      .map((mapping) => primaryActionFor(mapping, list.props.pricingUrl))
      .filter(Boolean)
    const contextual = guideAction ? [guideAction] : rowActions

    expect(contextual).toEqual([expected])
    expect(JSON.stringify({ guideAction, rowActions })).not.toMatch(/metafield|GLB parsing|render pipeline/i)
  })

  it.each([
    ['empty', baseData(), false],
    ['live', baseData({ mappings: [{ id: 'live', status: 'live', product: { title: 'Aviator' }, modelAsset: readyAsset }], counts: { all: 1, live: 1, needsAttention: 0 }, guide: { kind: 'complete', title: 'Everything is live', detail: '1 product is ready', action: null } })],
    ['add-to-theme', baseData({ mappings: [{ id: 'theme', status: 'add-to-theme', product: { title: 'Lumen' }, modelAsset: readyAsset, themeUrl: 'https://shop.test/admin/themes/current/editor?previewPath=%2Fproducts%2Flumen&addAppBlockId=key%2Ftryon_button&target=mainSection' }], counts: { all: 1, live: 0, needsAttention: 1 } })],
    ['model-issue', baseData({ mappings: [{ id: 'issue', status: 'model-issue', product: { title: 'Willow' }, modelAsset: readyAsset }], counts: { all: 1, live: 0, needsAttention: 1 } })],
    ['plan-limit', baseData({ mappings: [{ id: 'limit', status: 'plan-limit', product: { title: 'Cedar' }, modelAsset: readyAsset }], counts: { all: 1, live: 0, needsAttention: 1 }, usage: { used: 1, limit: 1, atLimit: true, pricingUrl: '/plans' } })],
  ])('keeps setup focused and adds operations only when there are mapped products for %s merchants', (_state, data, hasOperations = true) => {
    const page = render(data)
    expect(findComponent(page, WorkspaceGuide)).toBeDefined()
    expect(Boolean(findComponent(page, WorkspaceFilters))).toBe(hasOperations)
    expect(Boolean(findComponent(page, ProductOperationsList))).toBe(hasOperations)
    expect(findComponent(page, AddTryOnFlow)).toBeDefined()
  })

  it('passes the exact product theme URL and wires row interactions', () => {
    const mapping = {
      id: 'theme',
      productId: 'gid://shopify/Product/1',
      status: 'add-to-theme',
      product: { title: 'Lumen' },
      modelAsset: readyAsset,
      themeUrl: 'https://shop.test/admin/themes/current/editor?previewPath=%2Fproducts%2Flumen&addAppBlockId=key%2Ftryon_button&target=mainSection',
    }
    const page = render(baseData({ mappings: [mapping], counts: { all: 1, live: 0, needsAttention: 1 } }))
    const list = findComponent(page, ProductOperationsList)
    expect(list.props.mappings[0].themeUrl).toBe(mapping.themeUrl)

    list.props.onPreview(mapping)
    expect(harness.modalShow).toHaveBeenCalledWith('workspace-preview')
    list.props.onChangeModel(mapping)
    expect(harness.modalShow).toHaveBeenCalledWith('workspace-change-model')
    list.props.onRemove(mapping)
    expect(harness.modalShow).toHaveBeenCalledWith('workspace-remove-tryon')
    expect(harness.state.filter((value) => value === mapping)).toHaveLength(3)
  })

  it('closes, toasts, and revalidates after publication', () => {
    const page = render(baseData(), '?add=1&model=ready-model')
    const flow = findComponent(page, AddTryOnFlow)
    flow.props.onPublished()
    expect(harness.toast).toHaveBeenCalledWith('Try-on published')
    expect(harness.revalidate).toHaveBeenCalledTimes(1)
  })

  it('reviews a fit in place and offers a model swap from the review', () => {
    const mapping = { id: 'fit', productId: 'gid://shopify/Product/1', modelAssetId: 'asset-1', status: 'review-fit', product: { title: 'Aria' } }
    const onChooseModel = vi.fn()
    const dialog = ReviewFitDialog({ mapping, themeUrl: '/theme', onChooseModel })
    const html = renderToStaticMarkup(dialog)

    expect(dialog.props.id).toBe('workspace-review-fit')
    expect(dialog.props.heading).toBe('Review fit for Aria')
    expect(html).toContain('Review the fit')
    const review = [dialog.props.children].flat(Infinity).find((child) => child?.props?.modelAssetId)
    expect(review.props).toMatchObject({ modelAssetId: 'asset-1', themeUrl: '/theme' })
    const swap = findElements(dialog, 's-button').find((button) => button.props.children === 'Choose a different model')
    swap.props.onClick()
    expect(harness.modalHide).toHaveBeenCalledWith('workspace-review-fit')
    expect(onChooseModel).toHaveBeenCalledWith(mapping)
  })

  it('links Help from the workspace support panel', () => {
    const html = renderToStaticMarkup(render(baseData()))
    expect(html).toContain('<s-link href="/app/additional">Help and troubleshooting</s-link>')
  })

  it('opens with the search from ?q= so Models can link to one model\'s products', () => {
    const page = render(baseData({
      mappings: [{ id: 'live', status: 'live', product: { title: 'Aviator' }, modelAsset: readyAsset }],
      counts: { all: 1, live: 1, needsAttention: 0 },
    }), '?q=Pelmo')
    const filters = findElements(page, WorkspaceFilters)[0]
    expect(filters.props.query).toBe('Pelmo')
  })
})
