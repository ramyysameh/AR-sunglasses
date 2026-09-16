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
    ['check_fit', 'model-issue'],
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

  it('groups issues before theme work and live rows without reordering peers', () => {
    const mappings = [
      { id: 'live-newer', status: 'live' },
      { id: 'theme-newer', status: 'add-to-theme' },
      { id: 'issue', status: 'model-issue' },
      { id: 'theme-older', status: 'add-to-theme' },
      { id: 'live-older', status: 'live' },
    ]

    expect(sortWorkspaceMappings(mappings).map((mapping) => mapping.id)).toEqual([
      'issue',
      'theme-newer',
      'theme-older',
      'live-newer',
      'live-older',
    ])
  })
})
