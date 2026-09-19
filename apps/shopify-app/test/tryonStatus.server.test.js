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

  // The button's engine iframe is lazy and sits in a closed <dialog>, so
  // lastSeenLiveAt only moves when a shopper CLICKS try-on. Keying
  // "Not on your theme yet" off it told correctly-set-up merchants they had not
  // finished, and the admin kept offering "Add to theme" -- a deep link that
  // adds another copy of the block every time it is followed.
  it('is live once the block reports itself, before anyone has opened the try-on', () => {
    expect(productStatus({ blockSeenAt: seen, lastSeenLiveAt: null, modelAsset: ready }))
      .toMatchObject({ id: 'live', tone: 'success' })
  })

  it('still treats a shopper opening the try-on as proof the block is on the theme', () => {
    // Mappings created before blockSeenAt existed have only this signal, and a
    // shopper cannot open a try-on the block never rendered.
    expect(productStatus({ blockSeenAt: null, lastSeenLiveAt: seen, modelAsset: ready }))
      .toMatchObject({ id: 'live', tone: 'success' })
  })

  it('is not-on-theme when neither signal has arrived', () => {
    expect(productStatus({ blockSeenAt: null, lastSeenLiveAt: null, modelAsset: ready }))
      .toMatchObject({ id: 'not_on_theme', tone: 'warning' })
  })

  it('still reports a fit problem ahead of either theme signal', () => {
    expect(productStatus({ blockSeenAt: seen, lastSeenLiveAt: seen, modelAsset: { status: 'ready', confidence: 0.4 } }))
      .toMatchObject({ id: 'check_fit' })
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
