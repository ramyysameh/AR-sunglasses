/* eslint-disable react/prop-types -- lightweight fetcher form double */
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  cursor: 0,
  slots: [],
  pendingEffects: [],
  fetcher: {
    data: null,
    state: 'idle',
    Form: ({ children, ...props }) => React.createElement('form', props, children),
  },
  resourcePicker: vi.fn(),
  modal: { show: vi.fn(), hide: vi.fn() },
}))

function sameDeps(left, right) {
  return Boolean(left && right && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index])))
}

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal()),
  useReducer: (reducer, initialState) => {
    const index = runtime.cursor++
    if (!runtime.slots[index]) runtime.slots[index] = { value: initialState }
    return [
      runtime.slots[index].value,
      (action) => {
        runtime.slots[index].value = reducer(runtime.slots[index].value, action)
      },
    ]
  },
  useRef: (initialValue) => {
    const index = runtime.cursor++
    if (!runtime.slots[index]) runtime.slots[index] = { current: initialValue }
    return runtime.slots[index]
  },
  useCallback: (callback, deps) => {
    const index = runtime.cursor++
    const slot = runtime.slots[index]
    if (!slot || !sameDeps(slot.deps, deps)) runtime.slots[index] = { callback, deps }
    return runtime.slots[index].callback
  },
  useEffect: (effect, deps) => {
    const index = runtime.cursor++
    const slot = runtime.slots[index]
    if (!slot || !sameDeps(slot.deps, deps)) {
      runtime.pendingEffects.push({ effect, index })
      runtime.slots[index] = { ...slot, deps }
    }
  },
}))
vi.mock('react-router', () => ({
  useFetcher: () => runtime.fetcher,
}))
vi.mock('@shopify/app-bridge-react', () => ({
  useAppBridge: () => ({
    resourcePicker: runtime.resourcePicker,
    modal: runtime.modal,
  }),
}))

global.React = React

const { AddTryOnFlow } = await import('../app/components/AddTryOnFlow.jsx')

const assets = [{ id: 'ready-model', label: 'Ready frames', status: 'ready' }]

function findElements(node, type) {
  if (!node || typeof node !== 'object') return []
  if (typeof node.type === 'function' && ['ProductSummary', 'Form'].includes(node.type.name)) {
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

function createModalElement() {
  const listeners = new Map()
  return {
    addEventListener: vi.fn((name, callback) => listeners.set(name, callback)),
    removeEventListener: vi.fn((name, callback) => {
      if (listeners.get(name) === callback) listeners.delete(name)
    }),
    emit(name) {
      listeners.get(name)?.()
    },
  }
}

function flushEffects() {
  const effects = runtime.pendingEffects.splice(0)
  for (const { effect, index } of effects) {
    runtime.slots[index].cleanup?.()
    runtime.slots[index].cleanup = effect()
  }
}

function renderFlow(props, modalElement) {
  runtime.cursor = 0
  const flow = AddTryOnFlow(props)
  const modal = findElements(flow, 's-modal')[0]
  const ref = modal.ref ?? modal.props.ref
  ref.current = modalElement
  flushEffects()
  return flow
}

function flowState() {
  return runtime.slots.find((slot) => slot?.value?.step)?.value
}

beforeEach(() => {
  runtime.cursor = 0
  runtime.slots = []
  runtime.pendingEffects = []
  runtime.fetcher.data = null
  runtime.fetcher.state = 'idle'
  runtime.resourcePicker.mockReset()
  runtime.modal.show.mockReset()
  runtime.modal.hide.mockReset()
})

describe('AddTryOnFlow lifecycle effects', () => {
  it('notifies close exactly once after an explicit close finishes hiding', () => {
    const modalElement = createModalElement()
    const onClose = vi.fn()
    const props = { assets, open: true, onClose, onPublished: vi.fn() }
    const flow = renderFlow(props, modalElement)

    button(flow, 'Close').props.onClick()
    expect(onClose).not.toHaveBeenCalled()
    modalElement.emit('afterhide')
    modalElement.emit('afterhide')

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('notifies publish success and close exactly once after hiding', async () => {
    const modalElement = createModalElement()
    const onClose = vi.fn()
    const onPublished = vi.fn()
    const props = {
      assets,
      initialModelId: 'ready-model',
      open: true,
      onClose,
      onPublished,
    }
    runtime.resourcePicker.mockResolvedValue([{
      id: 'gid://shopify/Product/1',
      title: 'Aviator',
      handle: 'aviator',
      images: [],
    }])

    let flow = renderFlow(props, modalElement)
    await button(flow, 'Select product').props.onClick()
    flow = renderFlow(props, modalElement)
    findElements(flow, 'form')[0].props.onSubmit()
    renderFlow(props, modalElement)
    runtime.fetcher.data = { mapped: true }
    renderFlow(props, modalElement)

    expect(onPublished).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    modalElement.emit('afterhide')
    modalElement.emit('afterhide')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores the prior success response when a new session opens', async () => {
    const modalElement = createModalElement()
    const onClose = vi.fn()
    const onPublished = vi.fn()
    const openProps = {
      assets,
      initialModelId: 'ready-model',
      open: true,
      onClose,
      onPublished,
    }
    runtime.resourcePicker.mockResolvedValue([{
      id: 'gid://shopify/Product/1',
      title: 'Aviator',
      handle: 'aviator',
      images: [],
    }])

    let flow = renderFlow(openProps, modalElement)
    await button(flow, 'Select product').props.onClick()
    flow = renderFlow(openProps, modalElement)
    findElements(flow, 'form')[0].props.onSubmit()
    renderFlow(openProps, modalElement)
    runtime.fetcher.data = { mapped: true }
    renderFlow(openProps, modalElement)
    modalElement.emit('afterhide')
    renderFlow({ ...openProps, open: false }, modalElement)
    renderFlow(openProps, modalElement)

    expect(onPublished).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(flowState().open).toBe(true)
    expect(flowState().error).toBeNull()
  })

  it('ignores the prior error response when a new session opens', async () => {
    const modalElement = createModalElement()
    const props = {
      assets,
      initialModelId: 'ready-model',
      open: true,
      onClose: vi.fn(),
      onPublished: vi.fn(),
    }
    runtime.resourcePicker.mockResolvedValue([{
      id: 'gid://shopify/Product/1',
      title: 'Aviator',
      handle: 'aviator',
      images: [],
    }])

    let flow = renderFlow(props, modalElement)
    await button(flow, 'Select product').props.onClick()
    flow = renderFlow(props, modalElement)
    findElements(flow, 'form')[0].props.onSubmit()
    renderFlow(props, modalElement)
    runtime.fetcher.data = { error: 'Old failure' }
    flow = renderFlow(props, modalElement)
    expect(flowState().error).toBe('Old failure')
    button(flow, 'Close').props.onClick()
    modalElement.emit('afterhide')
    renderFlow({ ...props, open: false }, modalElement)
    renderFlow(props, modalElement)

    expect(flowState().error).toBeNull()
    expect(flowState().open).toBe(true)
  })
})
