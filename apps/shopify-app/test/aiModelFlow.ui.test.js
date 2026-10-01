import { describe, it, expect } from 'vitest'
import {
  PHOTO_SLOTS,
  photoError,
  canGenerate,
  balanceMessage,
  saveNeedsCharge,
  failureMessage,
  generationView,
  defaultImageSelection,
  toggleImage,
  canGenerateFromProduct,
  mappingMessage,
  productTooFewPhotos,
} from '../app/components/AiModelFlow.jsx'

const file = (type = 'image/jpeg', size = 1000) => ({ type, size, name: 'x' })

describe('photos', () => {
  it('has front, left and right required and back optional', () => {
    expect(PHOTO_SLOTS.map((s) => [s.key, s.required])).toEqual([
      ['front', true], ['left', true], ['right', true], ['back', false],
    ])
  })

  it('accepts JPG, PNG and WebP up to 10 MB', () => {
    expect(photoError(file('image/png'))).toBeNull()
    expect(photoError(file('image/gif'))).toMatch(/JPG, PNG or WebP/)
    expect(photoError(file('image/jpeg', 10 * 1048576 + 1))).toMatch(/10 MB/)
  })

  it('needs the three required photos, all valid', () => {
    expect(canGenerate({ front: file(), left: file() })).toBe(false)
    expect(canGenerate({ front: file(), left: file(), right: file() })).toBe(true)
    expect(canGenerate({ front: file(), left: file(), right: file(), back: file('image/gif') })).toBe(false)
  })
})

describe('balance', () => {
  it('shows free models left, the $5 price, or unlimited', () => {
    expect(balanceMessage({ allowance: 10, used: 3, unlimited: false, freeRemaining: 7 })).toBe('7 of 10 free AI models left')
    expect(balanceMessage({ allowance: 10, used: 10, unlimited: false, freeRemaining: 0 })).toBe('Next model: $5, added to your Shopify bill')
    expect(balanceMessage({ allowance: null, used: 4, unlimited: true, freeRemaining: null })).toBe('Unlimited AI models on your plan')
    expect(balanceMessage(null)).toBe('')
  })

  it('asks for the $5 confirmation only when nothing free is left', () => {
    expect(saveNeedsCharge({ unlimited: false, freeRemaining: 0 })).toBe(true)
    expect(saveNeedsCharge({ unlimited: false, freeRemaining: 1 })).toBe(false)
    expect(saveNeedsCharge({ unlimited: true, freeRemaining: null })).toBe(false)
    expect(saveNeedsCharge(null)).toBe(false)
  })
})

describe('generationView', () => {
  it('offers save, retry and discard on a ready result while retries remain', () => {
    expect(generationView({ status: 'ready', retriesLeft: 2 }).actions).toEqual(['save', 'retry', 'discard'])
    expect(generationView({ status: 'ready', retriesLeft: 0 }).actions).toEqual(['save', 'discard'])
  })

  it('shows progress with no actions while running or saving', () => {
    expect(generationView({ status: 'running', retriesLeft: 3 })).toMatchObject({ actions: [] })
    expect(generationView({ status: 'saving', retriesLeft: 3 })).toMatchObject({ actions: [] })
  })

  it('treats a running row with a retry reason as progress, not failure', () => {
    const view = generationView({ status: 'running', error: 'low_confidence', retriesLeft: 3 })
    expect(view.tone).toBe('info')
    expect(view.actions).toEqual([])
  })

  it('shows queued the same as running', () => {
    expect(generationView({ status: 'queued', retriesLeft: 3 })).toEqual(
      generationView({ status: 'running', retriesLeft: 3 }),
    )
  })

  it('never shows a raw status for an unknown one', () => {
    expect(generationView({ status: 'mystery', retriesLeft: 0 }).label).toBe('Working on it…')
  })

  it('explains a failure, says nothing was charged, and offers retry and dismiss', () => {
    const view = generationView({ status: 'failed', error: 'low_confidence', retriesLeft: 1 })
    expect(view.tone).toBe('critical')
    expect(view.label).toMatch(/plain background/)
    expect(view.actions).toEqual(['retry', 'discard'])
  })

  it('always tells the merchant a failure was free', () => {
    for (const code of ['low_confidence', 'invalid_model: x', 'timeout', 'start_failed', 'openai_failed', null]) {
      expect(failureMessage(code)).toMatch(/You weren't charged\./)
    }
  })
})

describe('product photo selection', () => {
  const imgs = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }))

  it('pre-ticks the first 4 images', () => {
    expect(defaultImageSelection(imgs)).toEqual(['a', 'b', 'c', 'd'])
    expect(defaultImageSelection(imgs.slice(0, 3))).toEqual(['a', 'b', 'c'])
  })

  it('toggles images and never selects more than 4', () => {
    expect(toggleImage(['a', 'b', 'c', 'd'], 'b')).toEqual(['a', 'c', 'd'])
    expect(toggleImage(['a', 'c', 'd'], 'e')).toEqual(['a', 'c', 'd', 'e'])
    expect(toggleImage(['a', 'b', 'c', 'd'], 'e')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('needs 3 or 4 ticked', () => {
    expect(canGenerateFromProduct(['a', 'b'])).toBe(false)
    expect(canGenerateFromProduct(['a', 'b', 'c'])).toBe(true)
    expect(canGenerateFromProduct(['a', 'b', 'c', 'd'])).toBe(true)
  })

  it('explains a product with too few photos', () => {
    expect(productTooFewPhotos(2)).toMatch(/only 2 photos/)
    expect(productTooFewPhotos(2)).toMatch(/Upload photos/)
  })
})

describe('mappingMessage', () => {
  it('says what happened to the product after a save', () => {
    expect(mappingMessage({ mapped: true }, 'GRIPZ')).toBe('Model saved and added to GRIPZ.')
    expect(mappingMessage({ mapped: false, reason: 'product_limit' }, 'GRIPZ')).toMatch(/product limit/)
    expect(mappingMessage({ mapped: false, reason: 'publish_failed' }, 'GRIPZ')).toMatch(/Add try-on/)
    expect(mappingMessage(undefined, 'GRIPZ')).toBeNull()
  })
})
