import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspaceGuide from '../app/components/WorkspaceGuide.jsx'
import WorkspaceFilters from '../app/components/WorkspaceFilters.jsx'
import ProductOperationsList from '../app/components/ProductOperationsList.jsx'
import { AddTryOnFlow } from '../app/components/AddTryOnFlow.jsx'

const harness = vi.hoisted(() => ({
  data: null,
  location: { search: '' },
  revalidate: vi.fn(),
  toast: vi.fn(),
  modalShow: vi.fn(),
  modalHide: vi.fn(),
  state: [],
  stateIndex: 0,
}))

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal()),
  useCallback: (callback) => callback,
  useState: (initial) => {
    const index = harness.stateIndex++
    if (harness.state[index] === undefined) harness.state[index] = initial
    return [harness.state[index], (value) => {
      harness.state[index] = typeof value === 'function' ? value(harness.state[index]) : value
    }]
  },
}))
vi.mock('react-router', () => ({
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

const { default: Workspace, initialAddRequest } = await import('../app/routes/app._index.jsx')

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
  it('renders Workspace with one page-level Add try-on primary', () => {
    const page = render(baseData())
    expect(page.type).toBe('s-page')
    expect(page.props.heading).toBe('Workspace')
    const pagePrimaries = findElements(page, 's-button').filter((button) => button.props.slot === 'primary-action')
    expect(pagePrimaries).toHaveLength(1)
    expect(pagePrimaries[0].props.children).toBe('Add try-on')
  })

  it('preselects only a ready model from an add deep link', () => {
    expect(initialAddRequest('?add=1&model=ready-model', [readyAsset])).toEqual({
      open: true,
      modelId: 'ready-model',
    })
    expect(initialAddRequest('?add=1&model=processing', [{ id: 'processing', status: 'processing' }]))
      .toEqual({ open: true, modelId: undefined })
    expect(initialAddRequest('?model=ready-model', [readyAsset])).toEqual({ open: false, modelId: undefined })
  })

  it.each([
    ['empty', baseData()],
    ['live', baseData({ mappings: [{ id: 'live', status: 'live', product: { title: 'Aviator' }, modelAsset: readyAsset }], counts: { all: 1, live: 1, needsAttention: 0 }, guide: { kind: 'complete', title: 'Everything is live', detail: '1 product is ready', action: null } })],
    ['add-to-theme', baseData({ mappings: [{ id: 'theme', status: 'add-to-theme', product: { title: 'Lumen' }, modelAsset: readyAsset, themeUrl: 'https://shop.test/admin/themes/current/editor?previewPath=%2Fproducts%2Flumen&addAppBlockId=key%2Ftryon_button&target=mainSection' }], counts: { all: 1, live: 0, needsAttention: 1 } })],
    ['model-issue', baseData({ mappings: [{ id: 'issue', status: 'model-issue', product: { title: 'Willow' }, modelAsset: readyAsset }], counts: { all: 1, live: 0, needsAttention: 1 } })],
    ['plan-limit', baseData({ mappings: [{ id: 'limit', status: 'plan-limit', product: { title: 'Cedar' }, modelAsset: readyAsset }], counts: { all: 1, live: 0, needsAttention: 1 }, usage: { used: 1, limit: 1, atLimit: true, pricingUrl: '/plans' } })],
  ])('composes guide, filters, operations, and flow for %s merchants', (_state, data) => {
    const page = render(data)
    expect(findComponent(page, WorkspaceGuide)).toBeDefined()
    expect(findComponent(page, WorkspaceFilters)).toBeDefined()
    expect(findComponent(page, ProductOperationsList)).toBeDefined()
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
})
