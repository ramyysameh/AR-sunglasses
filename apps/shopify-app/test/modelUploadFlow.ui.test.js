import { describe, expect, it, vi } from 'vitest'
import {
  uploadModalReducer,
  uploadValidationError,
} from '../app/components/ModelUploadFlow.jsx'

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

  it('records the finalized asset before the owner callback runs', () => {
    const onUploaded = vi.fn()
    const asset = { id: 'asset-1', status: 'READY', originalFilename: 'frame.glb' }
    onUploaded(asset)
    expect(onUploaded).toHaveBeenCalledWith(asset)
  })
})
