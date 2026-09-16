import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ModelUploadFlow,
  uploadModalReducer,
  uploadValidationError,
} from '../app/components/ModelUploadFlow.jsx'

const reactState = vi.hoisted(() => ({
  progress: null,
  reducerState: undefined,
}))
const appBridge = vi.hoisted(() => ({
  modal: { hide: vi.fn(), show: vi.fn() },
  toast: { show: vi.fn() },
}))
const revalidate = vi.hoisted(() => vi.fn())

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal()),
  useCallback: (callback) => callback,
  useEffect: () => undefined,
  useReducer: (reducer, initialState) => {
    if (reactState.reducerState === undefined) reactState.reducerState = initialState
    return [
      reactState.reducerState,
      (action) => {
        reactState.reducerState = reducer(reactState.reducerState, action)
      },
    ]
  },
  useRef: (initialValue) => ({ current: initialValue }),
  useState: (initialValue) => {
    if (initialValue !== null) return [initialValue, vi.fn()]
    return [reactState.progress, (value) => { reactState.progress = value }]
  },
}))
vi.mock('react-router', () => ({
  useRevalidator: () => ({ revalidate }),
}))
vi.mock('@shopify/app-bridge-react', () => ({
  useAppBridge: () => appBridge,
}))

global.React = React

function findElement(node, type) {
  if (!node || typeof node !== 'object') return null
  if (node.type === type) return node
  const children = Array.isArray(node.props?.children)
    ? node.props.children
    : [node.props?.children]
  for (const child of children.flat(Infinity)) {
    const found = findElement(child, type)
    if (found) return found
  }
  return null
}

beforeEach(() => {
  reactState.progress = null
  reactState.reducerState = undefined
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ModelUploadFlow', () => {
  it('rejects files other than GLB without clearing a previous valid selection', () => {
    const selected = new File(['glb'], 'frame.glb', { type: 'model/gltf-binary' })
    const state = { pendingFile: selected, uploadError: null }
    expect(uploadModalReducer(state, { type: 'reject' })).toEqual({
      pendingFile: selected,
      uploadError: 'Choose a .glb file up to 25 MB.',
    })
    expect(uploadValidationError(new File(['x'], 'frame.obj'))).toBe(
      'Choose a .glb file up to 25 MB.',
    )
  })

  it('uploads through presign and finalize and passes only the finalized asset to its owner', async () => {
    const onUploaded = vi.fn()
    const asset = { id: 'asset-1', status: 'READY', originalFilename: 'frame.glb' }
    const responseEnvelope = { uploaded: asset }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        text: async () => JSON.stringify({
          uploadUrl: 'https://uploads.example.test/model',
          storageRef: 'temp/model.glb',
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        text: async () => JSON.stringify(responseEnvelope),
      })
    vi.stubGlobal('fetch', fetchMock)

    const xhr = {
      abort: vi.fn(),
      open: vi.fn(),
      send: vi.fn(),
      setRequestHeader: vi.fn(),
      status: 200,
      upload: {},
    }
    xhr.send.mockImplementation(() => xhr.onload())
    vi.stubGlobal('XMLHttpRequest', vi.fn(() => xhr))

    const flow = ModelUploadFlow({ embedded: true, onUploaded })
    let content = flow.type(flow.props)
    const file = new File(['glb'], 'frame.glb', { type: 'model/gltf-binary' })
    findElement(content, 's-drop-zone').props.onChange({
      currentTarget: { files: [file] },
    })

    content = flow.type(flow.props)
    const uploadPromise = findElement(content, 's-button').props.onClick()
    content = flow.type(flow.props)
    expect(findElement(content, 'progress').props['aria-label']).toBe('Model upload progress')
    await uploadPromise

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(xhr.open).toHaveBeenCalledWith('PUT', 'https://uploads.example.test/model')
    expect(xhr.send).toHaveBeenCalledWith(file)
    expect(onUploaded).toHaveBeenCalledWith(asset)
    expect(onUploaded).not.toHaveBeenCalledWith(responseEnvelope)
  })
})
