/* eslint-disable react/prop-types -- lightweight route-dialog hook harness */
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ModelPicker from '../app/components/ModelPicker.jsx'

const runtime = vi.hoisted(() => ({
  cursor: 0,
  slots: [],
  effects: [],
  fetcher: {
    data: null,
    state: 'idle',
    Form: ({ children, ...props }) => React.createElement('form', props, children),
  },
  toast: vi.fn(),
  modalHide: vi.fn(),
}))

function sameDeps(left, right) {
  return Boolean(left && right && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index])))
}

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal()),
  useState: (initial) => {
    const index = runtime.cursor++
    if (!runtime.slots[index]) runtime.slots[index] = { value: initial }
    return [runtime.slots[index].value, (value) => { runtime.slots[index].value = value }]
  },
  useRef: (initial) => {
    const index = runtime.cursor++
    if (!runtime.slots[index]) runtime.slots[index] = { current: initial }
    return runtime.slots[index]
  },
  useEffect: (effect, deps) => {
    const index = runtime.cursor++
    const slot = runtime.slots[index]
    if (!slot || !sameDeps(slot.deps, deps)) {
      runtime.effects.push({ effect, index })
      runtime.slots[index] = { ...slot, deps }
    }
  },
}))
vi.mock('react-router', () => ({
  useFetcher: () => runtime.fetcher,
  useLoaderData: vi.fn(),
  useLocation: vi.fn(),
  useRevalidator: vi.fn(),
}))
vi.mock('@shopify/app-bridge-react', () => ({
  useAppBridge: () => ({
    toast: { show: runtime.toast },
    modal: { hide: runtime.modalHide },
  }),
}))
vi.mock('../app/shopify.server.js', () => ({ authenticate: { admin: vi.fn() } }))
vi.mock('../app/productActions.server.js', () => ({ handleProductAction: vi.fn() }))

global.React = React

const { ChangeModelDialog, RemoveTryOnDialog } = await import('../app/routes/app._index.jsx')

const mapping = {
  id: 'mapping-1',
  productId: 'gid://shopify/Product/1',
  modelAssetId: 'old-model',
  product: { title: 'Aviator' },
}

function findElements(node, type) {
  if (!node || typeof node !== 'object') return []
  if (typeof node.type === 'function' && node.type.name === 'Form') return findElements(node.type(node.props), type)
  const matches = node.type === type ? [node] : []
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]
  return matches.concat(children.flat(Infinity).flatMap((child) => findElements(child, type)))
}

function flushEffects() {
  const effects = runtime.effects.splice(0)
  effects.forEach(({ effect }) => effect())
}

function renderDialog(Component, props) {
  runtime.cursor = 0
  const dialog = Component(props)
  flushEffects()
  return dialog
}

beforeEach(() => {
  runtime.cursor = 0
  runtime.slots = []
  runtime.effects = []
  runtime.fetcher.data = null
  runtime.fetcher.state = 'idle'
  runtime.toast.mockReset()
  runtime.modalHide.mockReset()
})

describe.each([
  ['change', ChangeModelDialog, { mapping, assets: [{ id: 'old-model', status: 'ready' }] }, { mapped: true }, 'Model changed'],
  ['remove', RemoveTryOnDialog, { mapping }, { unmapped: true }, 'Try-on removed'],
])('%s dialog response lifecycle', (_name, Component, props, success, toast) => {
  it('consumes one success once despite callback identity changes', () => {
    const firstDone = vi.fn()
    let dialog = renderDialog(Component, { ...props, onDone: firstDone })
    findElements(dialog, 'form')[0].props.onSubmit()

    runtime.fetcher.data = success
    renderDialog(Component, { ...props, onDone: firstDone })
    const changedRevalidatorCallback = vi.fn()
    renderDialog(Component, { ...props, onDone: changedRevalidatorCallback })

    expect(runtime.toast).toHaveBeenCalledTimes(1)
    expect(runtime.toast).toHaveBeenCalledWith(toast)
    expect(firstDone).toHaveBeenCalledTimes(1)
    expect(changedRevalidatorCallback).not.toHaveBeenCalled()
  })

  it('requires a new response transition for each new submit', () => {
    const onDone = vi.fn()
    let dialog = renderDialog(Component, { ...props, onDone })
    findElements(dialog, 'form')[0].props.onSubmit()
    runtime.fetcher.data = success
    dialog = renderDialog(Component, { ...props, onDone })

    findElements(dialog, 'form')[0].props.onSubmit()
    renderDialog(Component, { ...props, onDone: vi.fn() })
    expect(runtime.toast).toHaveBeenCalledTimes(1)

    runtime.fetcher.data = { ...success }
    renderDialog(Component, { ...props, onDone })
    expect(runtime.toast).toHaveBeenCalledTimes(2)
    expect(onDone).toHaveBeenCalledTimes(2)
  })
})

describe('change model retry submission', () => {
  const renderChangeDialog = (session = 1) => renderDialog(ChangeModelDialog, {
    mapping,
    assets: [{ id: 'old-model', status: 'ready' }],
    onDone: vi.fn(),
    session,
  })

  const primaryButton = (dialog) => findElements(dialog, 's-button')
    .find((button) => button.props.slot === 'primary-action')

  const matchingFailure = () => ({
    retryable: true,
    productId: mapping.productId,
    modelAssetId: mapping.modelAssetId,
    error: 'Could not update the storefront.',
  })

  const submit = (dialog) => findElements(dialog, 'form')[0].props.onSubmit()
  const selectModel = (dialog, modelAssetId) => {
    findElements(dialog, ModelPicker)[0].props.onChange(modelAssetId)
  }

  const receiveMatchingFailure = (session = 1) => {
    let dialog = renderChangeDialog(session)
    submit(dialog)
    runtime.fetcher.data = matchingFailure()
    dialog = renderChangeDialog(session)
    return dialog
  }

  it('disables an unchanged model during normal editing', () => {
    const button = primaryButton(renderChangeDialog())

    expect(button.props.disabled).toBe(true)
    expect(button.props.children).toBe('Change model')
  })

  it('enables Try again for a matching retryable publication failure', () => {
    const dialog = receiveMatchingFailure()
    const button = primaryButton(dialog)

    expect(button.props.disabled).toBe(false)
    expect(button.props.children).toBe('Try again')
    expect(findElements(dialog, 's-banner')[0].props.children).toBe('Could not update the storefront.')
  })

  it('does not resurrect retry after selecting away from and back to the failed model', () => {
    let dialog = receiveMatchingFailure()
    expect(primaryButton(dialog).props.disabled).toBe(false)

    selectModel(dialog, 'another-model')
    dialog = renderChangeDialog()
    selectModel(dialog, mapping.modelAssetId)
    dialog = renderChangeDialog()

    expect(primaryButton(dialog).props.disabled).toBe(true)
    expect(primaryButton(dialog).props.children).toBe('Change model')
  })

  it('does not carry a retryable failure into a reopened session for the same mapping', () => {
    const failedDialog = receiveMatchingFailure(1)
    expect(primaryButton(failedDialog).props.disabled).toBe(false)

    const reopenedDialog = renderChangeDialog(2)

    expect(primaryButton(reopenedDialog).props.disabled).toBe(true)
    expect(primaryButton(reopenedDialog).props.children).toBe('Change model')
  })

  it('enables retry for a fresh matching failure in the reopened session', () => {
    receiveMatchingFailure(1)
    let dialog = renderChangeDialog(2)
    submit(dialog)
    runtime.fetcher.data = matchingFailure()

    dialog = renderChangeDialog(2)

    expect(primaryButton(dialog).props.disabled).toBe(false)
    expect(primaryButton(dialog).props.children).toBe('Try again')
  })

  it.each([
    ['another product', { retryable: true, productId: 'gid://shopify/Product/stale', modelAssetId: mapping.modelAssetId }],
    ['another model', { retryable: true, productId: mapping.productId, modelAssetId: 'stale-model' }],
    ['a non-retryable response', { retryable: false, productId: mapping.productId, modelAssetId: mapping.modelAssetId }],
  ])('keeps the unchanged model disabled for %s', (_case, response) => {
    runtime.fetcher.data = response

    const button = primaryButton(renderChangeDialog())

    expect(button.props.disabled).toBe(true)
    expect(button.props.children).toBe('Change model')
  })

  it('resubmits the exact mapping product and selected model values', () => {
    const dialog = receiveMatchingFailure()
    const fields = Object.fromEntries(
      findElements(dialog, 'input').map((input) => [input.props.name, input.props.value]),
    )

    expect(fields).toEqual({
      intent: 'map',
      productId: mapping.productId,
      modelAssetId: mapping.modelAssetId,
    })
  })
})
