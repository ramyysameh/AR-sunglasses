/* eslint-disable react/prop-types -- lightweight fetcher form double */
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  reducerState: undefined,
  fetcher: {
    data: null,
    state: 'idle',
    Form: ({ children, ...props }) => React.createElement('form', props, children),
  },
  resourcePicker: vi.fn(),
}))

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal()),
  useEffect: () => undefined,
  useCallback: (callback) => callback,
  useRef: (initialValue) => ({ current: initialValue }),
  useReducer: (reducer, initialState) => {
    if (harness.reducerState === undefined) harness.reducerState = initialState
    return [
      harness.reducerState,
      (action) => { harness.reducerState = reducer(harness.reducerState, action) },
    ]
  },
}))
vi.mock('react-router', () => ({
  useFetcher: () => harness.fetcher,
}))
vi.mock('@shopify/app-bridge-react', () => ({
  useAppBridge: () => ({
    resourcePicker: harness.resourcePicker,
    modal: { show: vi.fn(), hide: vi.fn() },
  }),
}))

global.React = React

const {
  AddTryOnFlow,
  addTryOnReducer,
  initialAddTryOnState,
  initialModelAsset,
} = await import('../app/components/AddTryOnFlow.jsx')

const assets = [
  { id: 'ready-model', label: 'Ready frames', status: 'ready' },
  { id: 'processing-model', label: 'Processing frames', status: 'processing' },
]

function findElements(node, type) {
  if (!node || typeof node !== 'object') return []
  if (typeof node.type === 'function' && ['ModelStep', 'ProductSummary', 'Form'].includes(node.type.name)) {
    return findElements(node.type(node.props), type)
  }
  const matches = node.type === type ? [node] : []
  const children = Array.isArray(node.props?.children)
    ? node.props.children
    : [node.props?.children]
  return matches.concat(children.flat(Infinity).flatMap((child) => findElements(child, type)))
}

function button(node, label) {
  return findElements(node, 's-button').find((candidate) => (
    [candidate.props.children].flat(Infinity).join('') === label
  ))
}

function findComponent(node, name) {
  if (!node || typeof node !== 'object') return null
  if (typeof node.type === 'function' && node.type.name === name) return node
  if (typeof node.type === 'function' && ['ModelStep', 'ProductSummary', 'Form'].includes(node.type.name)) {
    return findComponent(node.type(node.props), name)
  }
  const children = Array.isArray(node.props?.children)
    ? node.props.children
    : [node.props?.children]
  for (const child of children.flat(Infinity)) {
    const found = findComponent(child, name)
    if (found) return found
  }
  return null
}

beforeEach(() => {
  harness.reducerState = undefined
  harness.fetcher.data = null
  harness.fetcher.state = 'idle'
  harness.resourcePicker.mockReset()
})

describe('addTryOnReducer', () => {
  it('cannot advance to product selection without a model', () => {
    expect(addTryOnReducer(initialAddTryOnState, { type: 'next' }).step).toBe('model')
  })

  it('selects a newly uploaded model and advances', () => {
    const asset = { id: 'new-model', status: 'ready' }
    expect(addTryOnReducer(initialAddTryOnState, { type: 'model-selected', asset }))
      .toMatchObject({ step: 'product', modelAsset: asset })
  })

  it('preserves both selections after a publish error and clears only the error on back', () => {
    const state = {
      ...initialAddTryOnState,
      open: true,
      step: 'review',
      modelAsset: { id: 'm1' },
      product: { id: 'p1' },
    }
    const failed = addTryOnReducer(state, {
      type: 'publish-error',
      message: 'Could not publish. Try again.',
    })
    expect(failed).toMatchObject({
      step: 'review',
      modelAsset: { id: 'm1' },
      product: { id: 'p1' },
      error: 'Could not publish. Try again.',
      publishing: false,
    })
    expect(addTryOnReducer(failed, { type: 'back' })).toMatchObject({
      step: 'product',
      modelAsset: { id: 'm1' },
      product: { id: 'p1' },
      error: null,
    })
  })

  it('replaces a product selection and resets only on explicit close or success', () => {
    const withModel = addTryOnReducer(initialAddTryOnState, {
      type: 'model-selected',
      asset: { id: 'm1' },
    })
    const first = addTryOnReducer(withModel, { type: 'product-selected', product: { id: 'p1' } })
    const second = addTryOnReducer(first, { type: 'product-selected', product: { id: 'p2' } })

    expect(second).toMatchObject({ step: 'review', modelAsset: { id: 'm1' }, product: { id: 'p2' } })
    expect(addTryOnReducer(second, { type: 'close' })).toEqual(initialAddTryOnState)
    expect(addTryOnReducer(second, { type: 'publish-success' })).toEqual(initialAddTryOnState)
  })

  it('opens at product only for an available ready initial model', () => {
    expect(initialModelAsset(assets, 'ready-model')).toEqual(assets[0])
    expect(initialModelAsset(assets, 'processing-model')).toBeNull()
    expect(initialModelAsset(assets, 'missing-model')).toBeNull()
  })
})

describe('AddTryOnFlow interactions', () => {
  it('opens directly at product selection for a valid initial model handoff', () => {
    const flow = AddTryOnFlow({
      assets,
      initialModelId: 'ready-model',
      open: true,
      onClose: vi.fn(),
      onPublished: vi.fn(),
    })

    expect(button(flow, 'Select product')).toBeDefined()
    expect(button(flow, 'Use Ready frames')).toBeUndefined()
  })

  it('does not expose the product picker until a model exists', () => {
    let flow = AddTryOnFlow({ assets, open: true, onClose: vi.fn(), onPublished: vi.fn() })
    expect(button(flow, 'Select product')).toBeUndefined()

    button(flow, 'Use Ready frames').props.onClick()
    flow = AddTryOnFlow({ assets, open: true, onClose: vi.fn(), onPublished: vi.fn() })
    expect(button(flow, 'Select product')).toBeDefined()
  })

  it('auto-selects a finalized embedded upload and advances to product selection', () => {
    let flow = AddTryOnFlow({ assets, open: true, onClose: vi.fn(), onPublished: vi.fn() })
    const uploaded = { id: 'uploaded-model', filename: 'uploaded.glb', status: 'ready' }

    findComponent(flow, 'ModelUploadFlow').props.onUploaded(uploaded)
    flow = AddTryOnFlow({ assets, open: true, onClose: vi.fn(), onPublished: vi.fn() })

    expect(harness.reducerState).toMatchObject({ step: 'product', modelAsset: uploaded })
    expect(button(flow, 'Select product')).toBeDefined()
  })

  it('keeps the model and product step when the picker is cancelled', async () => {
    harness.reducerState = {
      ...initialAddTryOnState,
      open: true,
      step: 'product',
      modelAsset: assets[0],
    }
    harness.resourcePicker.mockResolvedValue(undefined)

    const flow = AddTryOnFlow({ assets, open: true, onClose: vi.fn(), onPublished: vi.fn() })
    await button(flow, 'Select product').props.onClick()

    expect(harness.resourcePicker).toHaveBeenCalledWith({ type: 'product', action: 'select' })
    expect(harness.reducerState).toMatchObject({
      open: true,
      step: 'product',
      modelAsset: assets[0],
      product: null,
    })
  })

  it('shows both selections and posts the mapping contract after product selection', async () => {
    harness.reducerState = {
      ...initialAddTryOnState,
      open: true,
      step: 'product',
      modelAsset: assets[0],
    }
    harness.resourcePicker.mockResolvedValue([{
      id: 'gid://shopify/Product/1',
      title: 'Aviator',
      handle: 'aviator',
      images: [{ originalSrc: 'https://cdn.example/aviator.jpg' }],
    }])

    let flow = AddTryOnFlow({ assets, open: true, onClose: vi.fn(), onPublished: vi.fn() })
    await button(flow, 'Select product').props.onClick()
    flow = AddTryOnFlow({ assets, open: true, onClose: vi.fn(), onPublished: vi.fn() })

    const inputs = Object.fromEntries(findElements(flow, 'input').map((input) => [
      input.props.name,
      input.props.value,
    ]))
    expect(inputs).toEqual({
      intent: 'map',
      productId: 'gid://shopify/Product/1',
      productHandle: 'aviator',
      modelAssetId: 'ready-model',
    })
    expect(findElements(flow, 's-thumbnail')[0].props.src).toBe('https://cdn.example/aviator.jpg')
    expect(button(flow, 'Publish try-on')).toBeDefined()
  })

  it('offers one retry action without losing either selection after failure', () => {
    harness.reducerState = {
      ...initialAddTryOnState,
      open: true,
      step: 'review',
      modelAsset: assets[0],
      product: { id: 'p1', title: 'Aviator', handle: 'aviator' },
      error: 'Could not publish. Try again.',
    }

    const flow = AddTryOnFlow({ assets, open: true, onClose: vi.fn(), onPublished: vi.fn() })
    expect(findElements(flow, 's-banner')).toHaveLength(1)
    expect(findElements(flow, 's-button').filter((candidate) => candidate.props.children === 'Try again'))
      .toHaveLength(1)
    expect(harness.reducerState.modelAsset.id).toBe('ready-model')
    expect(harness.reducerState.product.id).toBe('p1')
  })
})
