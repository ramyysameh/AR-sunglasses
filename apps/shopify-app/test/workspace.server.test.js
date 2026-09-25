import { describe, expect, it } from 'vitest'
import {
  normalizeWorkspaceStatus,
  sortWorkspaceMappings,
  workspaceCounts,
  workspaceGuide,
} from '../app/workspace.server.js'

describe('workspace data', () => {
  it('guides a new merchant to upload before choosing a product', () => {
    expect(workspaceGuide({ assets: [], mappings: [], usage: { atLimit: false } })).toMatchObject({
      kind: 'setup',
      title: 'Upload your first model',
      action: { id: 'add-try-on', label: 'Upload model' },
    })
  })

  it('counts every non-live mapping as needing attention', () => {
    const mappings = [
      { status: 'live' },
      { status: 'add-to-theme' },
      { status: 'model-issue' },
    ]
    expect(workspaceCounts(mappings)).toEqual({ all: 3, live: 1, needsAttention: 2 })
  })

  it.each([
    ['live', 'live'],
    ['not_on_theme', 'add-to-theme'],
    ['check_fit', 'review-fit'],
    ['unknown', 'model-issue'],
  ])('normalizes %s as %s', (source, expected) => {
    expect(normalizeWorkspaceStatus({ id: source })).toBe(expected)
  })

  it('prioritizes a model issue over theme and plan recovery', () => {
    const guide = workspaceGuide({
      assets: [{ id: 'asset-1' }],
      mappings: [
        { id: 'theme', status: 'add-to-theme', product: { title: 'Theme product' } },
        { id: 'model', status: 'model-issue', product: { title: 'Model product' } },
      ],
      usage: { atLimit: true, pricingUrl: '/plans' },
    })

    expect(guide).toEqual({
      kind: 'recovery',
      title: 'A model needs attention',
      detail: 'Model product',
      action: { id: 'choose-model', mappingId: 'model', label: 'Choose model' },
    })
  })

  it('guides a fit review to the review itself, not to swapping the model', () => {
    const guide = workspaceGuide({
      assets: [{ id: 'asset-1' }],
      mappings: [
        { id: 'theme', status: 'add-to-theme', product: { title: 'Theme product' } },
        { id: 'fit', status: 'review-fit', product: { title: 'Fit product' } },
      ],
      usage: { atLimit: false },
    })

    expect(guide).toEqual({
      kind: 'recovery',
      title: 'Review how a model fits',
      detail: 'Fit product',
      action: { id: 'review-fit', mappingId: 'fit', label: 'Review fit' },
    })
  })

  it.each([
    [1, '1 product is ready'],
    [3, '3 products are ready'],
  ])('pluralizes the all-live summary for %i product(s)', (count, detail) => {
    const mappings = Array.from({ length: count }, (_, index) => ({ id: `m${index}`, status: 'live' }))
    expect(workspaceGuide({ assets: [{ id: 'a' }], mappings, usage: { atLimit: false } }).detail).toBe(detail)
  })

  it('groups issues before theme work and live rows without reordering peers', () => {
    const mappings = [
      { id: 'live-newer', status: 'live' },
      { id: 'theme-newer', status: 'add-to-theme' },
      { id: 'fit', status: 'review-fit' },
      { id: 'issue', status: 'model-issue' },
      { id: 'theme-older', status: 'add-to-theme' },
      { id: 'live-older', status: 'live' },
    ]

    expect(sortWorkspaceMappings(mappings).map((mapping) => mapping.id)).toEqual([
      'issue',
      'fit',
      'theme-newer',
      'theme-older',
      'live-newer',
      'live-older',
    ])
  })
})
