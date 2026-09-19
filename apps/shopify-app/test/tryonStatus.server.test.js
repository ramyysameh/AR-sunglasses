import { describe, it, expect } from 'vitest'
import { productStatus } from '../app/tryonStatus.server.js'

const seen = new Date('2026-09-01T00:00:00Z')
const ready = { status: 'ready', confidence: 0.9 }

describe('productStatus', () => {
  it('is live when calibrated and seen working', () => {
    expect(productStatus({ lastSeenLiveAt: seen, modelAsset: ready }))
      .toMatchObject({ id: 'live', tone: 'success' })
  })

  it('is not-on-theme when never seen', () => {
    expect(productStatus({ lastSeenLiveAt: null, modelAsset: ready }))
      .toMatchObject({ id: 'not_on_theme', tone: 'warning' })
  })

  it('is check-fit when the model needs a manual anchor', () => {
    expect(productStatus({ lastSeenLiveAt: seen, modelAsset: { status: 'needs_manual', confidence: 0.9 } }))
      .toMatchObject({ id: 'check_fit' })
  })

  // The id stays `check_fit` (the workspace's status normalization and
  // filters key off it), but the merchant-facing label reads "Review
  // fit" everywhere now -- it names the action every review surface offers.
  it('surfaces the check-fit status with the "Review fit" label merchants act on', () => {
    expect(productStatus({ lastSeenLiveAt: seen, modelAsset: { status: 'ready', confidence: 0.4 } }))
      .toEqual({ id: 'check_fit', label: 'Review fit', tone: 'warning' })
  })

  it('is check-fit when confidence is low', () => {
    expect(productStatus({ lastSeenLiveAt: seen, modelAsset: { status: 'ready', confidence: 0.4 } }))
      .toMatchObject({ id: 'check_fit' })
  })

  // Precedence: a fit problem outranks an install problem. A merchant who fixes
  // the theme block only to find the glasses sit wrong was sent down the wrong
  // path first.
  it('prefers check-fit over not-on-theme when both apply', () => {
    expect(productStatus({ lastSeenLiveAt: null, modelAsset: { status: 'needs_manual', confidence: 0.4 } }))
      .toMatchObject({ id: 'check_fit' })
  })

  it('treats unknown confidence as acceptable', () => {
    expect(productStatus({ lastSeenLiveAt: seen, modelAsset: { status: 'ready', confidence: null } }))
      .toMatchObject({ id: 'live' })
  })

  it('never leaks pipeline words in the label', () => {
    const labels = [
      productStatus({ lastSeenLiveAt: seen, modelAsset: ready }).label,
      productStatus({ lastSeenLiveAt: null, modelAsset: ready }).label,
      productStatus({ lastSeenLiveAt: seen, modelAsset: { status: 'needs_manual' } }).label,
    ].join(' ').toLowerCase()
    for (const word of ['geometric', 'confidence', 'anchor', 'calibrat', 'needs_manual']) {
      expect(labels).not.toContain(word)
    }
  })
})
