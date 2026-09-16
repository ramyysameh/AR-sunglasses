import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const routeState = vi.hoisted(() => ({ loaderData: null, navigate: vi.fn() }))

vi.mock('react-router', () => ({
  useLoaderData: () => routeState.loaderData,
  useNavigate: () => routeState.navigate,
  useFetcher: () => ({ data: null, state: 'idle', submit: vi.fn() }),
  useRevalidator: () => ({ revalidate: vi.fn() }),
}))
vi.mock('@shopify/app-bridge-react', () => ({
  useAppBridge: () => ({
    modal: { hide: vi.fn(), show: vi.fn() },
    toast: { show: vi.fn() },
  }),
}))
vi.mock('@shopify/shopify-app-react-router/server', () => ({
  boundary: { headers: vi.fn() },
}))
vi.mock('../app/shopify.server.js', () => ({ authenticate: { admin: vi.fn() } }))
vi.mock('../app/db.server.js', () => ({ default: {} }))
vi.mock('../app/storage.server.js', () => ({ deleteModelGlb: vi.fn() }))

global.React = React

const {
  createUploadCancellationCoordinator,
  default: Models,
  modelName,
  modalSessionReducer,
  renameSubmitDisabled,
  UploadModal,
  uploadModalReducer,
  uploadModalHideBehavior,
  uploadValidationError,
} = await import('../app/routes/app.models.jsx')

beforeEach(() => {
  routeState.navigate.mockReset()
  routeState.loaderData = {
    assets: [
      {
        id: 'used-model',
        label: 'Pelmo black',
        filename: 'pelmo.glb',
        status: 'ready',
        mappingCount: 2,
      },
      {
        id: 'unused-model',
        label: null,
        filename: 'aviator.glb',
        status: 'needs_review',
        mappingCount: 0,
      },
    ],
  }
})

describe('Models UI behavior', () => {
  it('hands an uploaded model directly to the Workspace add flow', () => {
    const modal = UploadModal()

    modal.props.onUploaded({ id: 'gid://ar/Model Asset/black & gold' })

    expect(routeState.navigate).toHaveBeenCalledWith(
      '/app?add=1&model=gid%3A%2F%2Far%2FModel%20Asset%2Fblack%20%26%20gold',
    )
  })

  it('uses the merchant label before the filename and short id fallbacks', () => {
    expect(modelName({ id: '123456789', label: '  Pelmo black  ', filename: 'pelmo.glb' })).toBe('Pelmo black')
    expect(modelName({ id: '123456789', label: null, filename: 'pelmo.glb' })).toBe('pelmo.glb')
    expect(modelName({ id: '123456789', label: null, filename: null })).toBe('Model 12345678')
  })

  it('rejects missing, non-GLB, and oversized uploads before starting', () => {
    expect(uploadValidationError(null)).toBe('Choose a .glb file up to 25 MB.')
    expect(uploadValidationError({ name: 'frames.obj', size: 1024 })).toBe('Choose a .glb file up to 25 MB.')
    expect(uploadValidationError({ name: 'frames.glb', size: 25 * 1048576 + 1 })).toBe('Choose a .glb file up to 25 MB.')
    expect(uploadValidationError({ name: 'frames.GLB', size: 25 * 1048576 })).toBeNull()
  })

  it('allows clearing a custom name but prevents unchanged rename submissions', () => {
    expect(renameSubmitDisabled({ draft: '', currentLabel: 'Pelmo black', state: 'idle' })).toBe(false)
    expect(renameSubmitDisabled({ draft: ' Pelmo black ', currentLabel: 'Pelmo black', state: 'idle' })).toBe(true)
    expect(renameSubmitDisabled({ draft: '   ', currentLabel: null, state: 'idle' })).toBe(true)
    expect(renameSubmitDisabled({ draft: 'Aviator', currentLabel: null, state: 'submitting' })).toBe(true)
  })

  it('starts a clean modal session after dismissal', () => {
    const initial = { modelId: null, session: 0 }
    const opened = modalSessionReducer(initial, { type: 'open', modelId: 'used-model' })
    const dismissed = modalSessionReducer(opened, { type: 'dismiss' })
    const reopened = modalSessionReducer(dismissed, { type: 'open', modelId: 'used-model' })

    expect(opened.modelId).toBe('used-model')
    expect(dismissed.modelId).toBeNull()
    expect(reopened.modelId).toBe('used-model')
    expect(reopened.session).not.toBe(opened.session)
  })

  it('cancels the current upload signal and XHR without reusing either session', () => {
    const coordinator = createUploadCancellationCoordinator()
    const firstSignal = coordinator.begin()
    const xhr = { abort: vi.fn() }

    coordinator.attachXhr(xhr)
    coordinator.abortForUnmount()

    expect(firstSignal.aborted).toBe(true)
    expect(xhr.abort).toHaveBeenCalledOnce()

    const secondSignal = coordinator.begin()
    expect(secondSignal).not.toBe(firstSignal)
    expect(secondSignal.aborted).toBe(false)
  })

  it('keeps delete results owned by the shared modal until native dismissal', () => {
    const initial = { modelId: null, session: 0 }
    const opened = modalSessionReducer(initial, { type: 'open', modelId: 'unused-model' })
    const dismissed = modalSessionReducer(opened, { type: 'dismiss' })
    const reopened = modalSessionReducer(dismissed, { type: 'open', modelId: 'next-model' })

    expect(opened.modelId).toBe('unused-model')
    expect(dismissed.modelId).toBeNull()
    expect(reopened.modelId).toBe('next-model')
    expect(reopened.session).not.toBe(opened.session)
  })

  it('keeps the previous file after a rejected drop and exposes the required GLB guidance', () => {
    const selected = { pendingFile: { name: 'frames.obj' }, uploadError: null }

    expect(uploadModalReducer(selected, { type: 'reject' })).toEqual({
      pendingFile: { name: 'frames.obj' },
      uploadError: 'Choose a .glb file up to 25 MB.',
    })
  })

  it('reopens a busy upload modal but resets an idle dismissed modal', () => {
    expect(uploadModalHideBehavior(true)).toEqual({ reopen: true, reset: false })
    expect(uploadModalHideBehavior(false)).toEqual({ reopen: false, reset: true })
  })

  it('renders one upload action with valid modal targets', () => {
    const html = renderToStaticMarkup(React.createElement(Models))
    const targets = [...html.matchAll(/commandFor="([^"]+)"/g)].map((match) => match[1])

    expect(html).toContain('slot="primary-action"')
    expect(html.match(/commandFor="upload-model" command="--show"/g)).toHaveLength(1)
    expect(html).toContain('Pelmo black')
    expect(html).toContain('pelmo.glb')
    expect(html).toContain('Used by 2 products')
    expect(html).toContain('href="/app"')
    expect(html).toContain('Check fit')
    expect(html).not.toMatch(/A1 pipeline|calibrat|manual anchor|geometric confidence/i)
    expect(html.match(/id="rename-model"/g)).toHaveLength(1)
    expect(html.match(/id="delete-model"/g)).toHaveLength(1)
    expect(html.match(/commandFor="delete-model"/g)).toHaveLength(2)
    expect(html).toContain('accessibilityLabel="Choose a GLB model file"')

    for (const target of new Set(targets)) {
      const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      expect(html.match(new RegExp(`id="${escapedTarget}"`, 'g'))).toHaveLength(1)
    }
  })
})
