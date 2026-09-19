import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const routeState = vi.hoisted(() => ({ loaderData: null }))

vi.mock('react-router', () => ({
  useLoaderData: () => routeState.loaderData,
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
  attachDropRejectedListener,
  createUploadCancellationCoordinator,
  default: Models,
  DropZoneField,
  modelName,
  modalSessionReducer,
  renameSubmitDisabled,
  uploadModalReducer,
  uploadModalHideBehavior,
  uploadValidationError,
} = await import('../app/routes/app.models.jsx')
const { default: ModelPicker, filterModelAssets } = await import('../app/components/ModelPicker.jsx')

beforeEach(() => {
  routeState.loaderData = {
    assets: [
      {
        id: 'used-model',
        label: 'Pelmo black',
        filename: 'pelmo.glb',
        status: 'ready',
        mappingCount: 2,
        // Loader-computed (tryonStatus.server.js's needsFitReview), not
        // derived here from status -- this test mocks useLoaderData
        // directly, bypassing the real loader, so the fixture has to supply
        // what the loader would have computed.
        needsReview: false,
      },
      {
        id: 'unused-model',
        label: null,
        filename: 'aviator.glb',
        status: 'needs_review',
        mappingCount: 0,
        needsReview: true,
      },
    ],
    themeUrl: 'https://admin.shopify.com/theme',
  }
})

describe('Models UI behavior', () => {
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

  // Important-1 regression guard: `onDropRejected` on <s-drop-zone> was a
  // dead JSX prop under React 18 (`dropRejected` is not in
  // simpleEventPluginEvents), so a merchant dropping the wrong file type got
  // silence instead of a banner -- the reject branch above was unit-tested
  // but could never actually fire in production. This repo's test
  // environment has no jsdom, so it can't mount <s-drop-zone> and dispatch a
  // real `droprejected` DOM event -- instead this exercises the real
  // attach/detach function the component's useEffect calls, against a plain
  // fake element, and chains its output straight into the reducer above to
  // prove the full path: real listener code -> real dispatched action ->
  // the exact banner text a merchant would see.
  it('wires droprejected on the drop-zone element to the reducer\'s required GLB guidance', () => {
    const listeners = {}
    const fakeDropZone = {
      addEventListener: (type, handler) => {
        listeners[type] = handler
      },
      removeEventListener: vi.fn(),
    }
    const dispatchUpload = vi.fn()

    const detach = attachDropRejectedListener(fakeDropZone, dispatchUpload)
    expect(typeof listeners.droprejected).toBe('function')

    listeners.droprejected()
    expect(dispatchUpload).toHaveBeenCalledExactlyOnceWith({ type: 'reject' })

    // Feed the dispatched action straight into the real reducer, the same
    // one wired to UploadModalContent's state -- this is what closes the
    // loop from "the DOM event fired" to "the merchant sees the banner".
    const nextState = uploadModalReducer(
      { pendingFile: { name: 'frames.obj' }, uploadError: null },
      dispatchUpload.mock.calls[0][0],
    )
    expect(nextState.uploadError).toBe('Choose a .glb file up to 25 MB.')

    detach()
    expect(fakeDropZone.removeEventListener).toHaveBeenCalledExactlyOnceWith('droprejected', listeners.droprejected)
  })

  // Structural half of the Important-1 fix: proves the ref that
  // attachDropRejectedListener above needs a live element for is actually
  // handed to the real <s-drop-zone> (and that onDropRejected is gone, not
  // just unused), since it cannot be exercised end-to-end without jsdom.
  it('hands the drop-zone ref to the real s-drop-zone element with no dead onDropRejected prop', () => {
    const dropZoneRef = { current: null }
    const element = DropZoneField({ dropZoneRef, disabled: false, onInput: vi.fn() })

    expect(element.type).toBe('s-drop-zone')
    expect(element.ref).toBe(dropZoneRef)
    expect(element.props.onDropRejected).toBeUndefined()
  })

  it('reopens a busy upload modal but resets an idle dismissed modal', () => {
    expect(uploadModalHideBehavior(true)).toEqual({ reopen: true, reset: false })
    expect(uploadModalHideBehavior(false)).toEqual({ reopen: false, reset: true })
  })

  it('keeps Models as a library without a second upload action', () => {
    const html = renderToStaticMarkup(React.createElement(Models))
    const targets = [...html.matchAll(/commandFor="([^"]+)"/g)].map((match) => match[1])

    expect(html).not.toContain('upload-model')
    expect(html).toContain('Pelmo black')
    expect(html).toContain('pelmo.glb')
    expect(html).toContain('Used by 2 products')
    // Navigation follows upstream's workspace redesign: the standalone
    // Products page is gone (app.products.jsx redirects to /app), so Models
    // links at the Workspace. The merchant-facing copy stays "Review fit"
    // (the status id is still `check_fit`) -- that wording matches the action
    // every review surface actually offers.
    expect(html).toContain('href="/app"')
    expect(html).toContain('Review fit')
    expect(html).not.toMatch(/Check fit/)
    expect(html).not.toMatch(/A1 pipeline|calibrat|manual anchor|geometric confidence/i)
    expect(html.match(/id="rename-model"/g)).toHaveLength(1)
    expect(html.match(/id="delete-model"/g)).toHaveLength(1)
    expect(html.match(/commandFor="delete-model"/g)).toHaveLength(2)
    expect(html.match(/id="review-model-fit"/g)).toHaveLength(1)
    // One card action (--show) plus the modal's own Close button (--hide).
    expect(html.match(/commandFor="review-model-fit"/g)).toHaveLength(2)
    // The drop zone assertion that used to live here is deliberately gone:
    // under upstream's redesign Models is a library only, and the upload drop
    // zone moved into the workspace's ModelUploadFlow (this very test's
    // `not.toContain('upload-model')` above is upstream asserting exactly
    // that). Coverage for the drop zone -- including the React 18 onInput /
    // droprejected wiring -- now lives in modelUploadFlow.ui.test.js.


    for (const target of new Set(targets)) {
      const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      expect(html.match(new RegExp(`id="${escapedTarget}"`, 'g'))).toHaveLength(1)
    }
  })

  // Brief's Step 1 requirement, made explicit with two review-required
  // models (the fixture above only has one, which can't distinguish "one
  // shared modal" from "one modal per card" -- see the code comment below).
  it('gives every review-required model a Review fit action against one shared modal, not one per card', () => {
    routeState.loaderData = {
      assets: [
        { id: 'used-model', label: 'Pelmo black', filename: 'pelmo.glb', status: 'ready', mappingCount: 2, needsReview: false },
        { id: 'unused-model', label: null, filename: 'aviator.glb', status: 'needs_review', mappingCount: 0, needsReview: true },
        { id: 'third-model', label: 'Third frame', filename: 'third.glb', status: 'needs_review', mappingCount: 0, needsReview: true },
      ],
      themeUrl: 'https://admin.shopify.com/theme',
    }

    const html = renderToStaticMarkup(React.createElement(Models))

    // Both review-required models expose their own action, plus the modal's
    // own Close button (--hide) beside them...
    expect(html.match(/commandFor="review-model-fit"/g)).toHaveLength(3)
    expect(html).toContain('accessibilityLabel="Review fit for aviator.glb"')
    expect(html).toContain('accessibilityLabel="Review fit for Third frame"')
    // ...but every one of those actions targets the SAME single modal. A
    // per-card implementation could break this two different ways: reusing
    // the literal id "review-model-fit" on more than one <s-modal> (this
    // match would then be length 2, not 1), or giving each modal its own
    // suffixed id like `review-model-fit-${asset.id}` (no element would have
    // the exact id "review-model-fit" any more, so this match would be
    // null/length 0) -- either way, not the single match a shared modal
    // produces.
    expect(html.match(/id="review-model-fit"/g)).toHaveLength(1)
    // The Ready model gets neither the badge text nor the action.
    expect(html).not.toMatch(/accessibilityLabel="Review fit for Pelmo black"/)
  })

  // Important-3 regression guard: needsReview (loader-computed from
  // tryonStatus.server.js's single-sourced needsFitReview) must gate the
  // badge/action, not raw asset.status -- an asset can be status:'ready' and
  // still need review on low confidence. Before this fix, Models keyed off
  // asset.status alone, so this exact shape rendered "Ready" with no action
  // while Products (via productStatus, same confidence threshold) showed
  // "Review fit" for the identical asset -- and app.additional.jsx's Help
  // copy sends a merchant here expecting to find that action.
  it('offers Review fit for a status:"ready", low-confidence asset', () => {
    routeState.loaderData = {
      assets: [
        {
          id: 'low-confidence-ready',
          label: 'Low confidence',
          filename: 'low-confidence.glb',
          status: 'ready',
          confidence: 0.4,
          mappingCount: 0,
          needsReview: true,
        },
      ],
      themeUrl: 'https://admin.shopify.com/theme',
    }

    const html = renderToStaticMarkup(React.createElement(Models))

    expect(html).toContain('accessibilityLabel="Review fit for Low confidence"')
    expect(html).not.toMatch(/>Ready</)
  })
})

// ModelPicker is consumed by app.products.jsx, not this route, but this
// route's loader is where the real ModelAsset shape (label/filename/status/
// mappingCount straight off prisma.modelAsset.findMany) comes from -- so
// exercise the compact/searchable picker against assets shaped like that,
// not just appProducts.ui.test.js's minimal {id, label} fixtures.
describe('ModelPicker (assets shaped like the Models route loader)', () => {
  const assets = [
    { id: 'used-model', label: 'Pelmo black', filename: 'pelmo.glb', status: 'ready', mappingCount: 2 },
    { id: 'unused-model', label: null, filename: 'aviator.glb', status: 'needs_review', mappingCount: 0 },
  ]

  it('filters by the merchant-facing name, falling back to filename', () => {
    expect(filterModelAssets(assets, 'pelmo')).toEqual([assets[0]])
    expect(filterModelAssets(assets, 'aviator')).toEqual([assets[1]])
    expect(filterModelAssets(assets, 'nonexistent')).toEqual([])
  })

  it('renders a search field and mounts exactly one preview, for the selected asset only', () => {
    const html = renderToStaticMarkup(
      React.createElement(ModelPicker, { assets, value: 'unused-model', onChange: vi.fn() }),
    )

    expect(html).toContain('s-search-field')
    expect(html.match(/<model-viewer/g) ?? []).toHaveLength(0)
    expect(html.match(/Loading 3D preview/g)).toHaveLength(1)
  })
})
