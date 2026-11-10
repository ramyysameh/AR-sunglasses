import { describe, expect, it } from 'vitest'
import { setupSteps, tryOnActiveFromExtensions, withEmbedActive, workspaceCounts, workspaceGuide } from '../app/workspaceState.js'

const theme = (blocks) => ({ handle: 'tryon-button', type: 'theme_app_extension', activations: blocks })
const block = (handle, status) => ({ handle, name: handle, target: 'body', status, activations: [] })

describe('tryOnActiveFromExtensions', () => {
  it('is true when the try-on embed is active on the published theme', () => {
    expect(tryOnActiveFromExtensions([theme([block('tryon_embed', 'active')])])).toBe(true)
  })

  it('also counts the older product-page block', () => {
    expect(tryOnActiveFromExtensions([theme([block('tryon_embed', 'available'), block('tryon_button', 'active')])])).toBe(true)
  })

  it('is false when Shopify reports the embed as only available', () => {
    expect(tryOnActiveFromExtensions([theme([block('tryon_embed', 'available'), block('tryon_button', 'available')])])).toBe(false)
  })

  it('ignores other apps-style handles and UI extensions', () => {
    expect(tryOnActiveFromExtensions([
      { handle: 'admin-link', type: 'ui_extension', activations: [{ target: 'admin.product-details.action.render' }] },
      theme([block('something_else', 'active')]),
    ])).toBe(false)
  })

  it('is null when App Bridge gives no usable answer', () => {
    expect(tryOnActiveFromExtensions(undefined)).toBeNull()
    expect(tryOnActiveFromExtensions([])).toBeNull()
    expect(tryOnActiveFromExtensions([{ type: 'ui_extension', activations: [] }])).toBeNull()
  })
})

describe('withEmbedActive', () => {
  const usage = { atLimit: false, pricingUrl: 'https://admin.shopify.com/pricing' }
  const assets = [{ id: 'a1', status: 'ready' }]
  const mappings = [
    { id: 'm1', status: 'add-to-theme', themeUrl: 'https://embed', product: { title: 'Aviator' } },
    { id: 'm2', status: 'review-fit', product: { title: 'Round' } },
  ]
  const loader = {
    assets,
    mappings,
    usage,
    counts: workspaceCounts(mappings),
    guide: workspaceGuide({ assets, mappings, usage }),
    setup: setupSteps({ assets, mappings, storeLive: false }),
    embedUrl: 'https://embed',
  }

  it('leaves the loader data untouched unless the embed is confirmed on', () => {
    expect(withEmbedActive(loader, null)).toBe(loader)
    expect(withEmbedActive(loader, false)).toBe(loader)
  })

  it('finishes setup and turns "Not live yet" rows live once the embed is on', () => {
    expect(loader.setup.steps[2].state).toBe('current')
    const next = withEmbedActive(loader, true)
    expect(next.setup.done).toBe(true)
    expect(next.mappings.find((m) => m.id === 'm1').status).toBe('live')
    // A row that needs a fit review still does.
    expect(next.mappings.find((m) => m.id === 'm2').status).toBe('review-fit')
    expect(next.counts).toEqual({ all: 2, live: 1, needsAttention: 1 })
    expect(next.guide.action.id).toBe('review-fit')
    expect(next.embedUrl).toBe('https://embed')
  })

  it('drops the "Turn on try-on" guide when nothing else needs doing', () => {
    const onlyTheme = { ...loader, mappings: [mappings[0]], guide: workspaceGuide({ assets, mappings: [mappings[0]], usage }) }
    expect(onlyTheme.guide.action.id).toBe('theme')
    expect(withEmbedActive(onlyTheme, true).guide.kind).toBe('complete')
  })
})
