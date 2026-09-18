import { readFile } from 'node:fs/promises'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SetupGuide, { buildSetupSteps, nextSetupAction } from '../app/components/SetupGuide.jsx'

global.React = React

const routeUrl = new URL('../app/routes/app._index.jsx', import.meta.url)
const setupGuideUrl = new URL('../app/components/SetupGuide.jsx', import.meta.url)

describe('home Polaris contract', () => {
  it('uses valid subdued text and numeric ARIA values', async () => {
    const source = await readFile(routeUrl, 'utf8')
    expect(source).not.toContain('tone="subdued"')
    expect(source).not.toContain('aria-valuemin="0"')
    expect(source).toContain('color="subdued"')
    expect(source).toContain('aria-valuemin={0}')
  })

  // SetupGuide.jsx now owns the setup-guide markup that used to live inline
  // in app._index.jsx, so the same contract (no literal hex colors, no
  // tone="subdued" misuse) must hold there too.
  it('keeps SetupGuide.jsx free of literal colors and tone="subdued" misuse', async () => {
    const source = await readFile(setupGuideUrl, 'utf8')
    expect(source).not.toContain('tone="subdued"')
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})

describe('setup guide next action', () => {
  it.each([
    [{ modelCount: 0, mappingCount: 0, liveCount: 0 }, 'Upload model', '/app/models'],
    [{ modelCount: 1, mappingCount: 0, liveCount: 0 }, 'Add try-on', '/app/products'],
    [{ modelCount: 1, mappingCount: 1, liveCount: 0 }, 'Add to theme', 'https://admin.shopify.com/theme'],
    [{ modelCount: 1, mappingCount: 1, liveCount: 1 }, 'Manage products', '/app/products'],
  ])('chooses the next useful action for %j', (counts, label, href) => {
    const steps = buildSetupSteps({ ...counts, themeUrl: 'https://admin.shopify.com/theme' })
    expect(nextSetupAction(steps)).toMatchObject({ actionLabel: label, href })
  })
})

describe('SetupGuide rendering', () => {
  it('gives every incomplete step an action, marks completed steps Done, and reports progress', () => {
    const html = renderToStaticMarkup(
      React.createElement(SetupGuide, {
        modelCount: 1,
        mappingCount: 0,
        liveCount: 0,
        themeUrl: 'https://admin.shopify.com/theme',
      }),
    )

    // Progress copy.
    expect(html).toContain('1 out of 3 steps completed.')

    // Completed step (model) is compact and marked Done.
    expect(html).toContain('Done')

    // Both incomplete steps (product, theme) still offer an action. The
    // product step's own label ("Add try-on to a product") already contains
    // the substring "Add try-on", so a plain `toContain('Add try-on')` would
    // pass even if its button were never rendered. Assert the label and the
    // button separately: the button check requires an <s-button> whose only
    // content is exactly "Add try-on", which only the button itself matches
    // (the label has trailing text, and accessibilityLabel is an attribute
    // value, not element content, so neither can satisfy this pattern).
    expect(html).toContain('Add try-on to a product')
    expect(html).toMatch(/<s-button[^>]*>Add try-on<\/s-button>/)
    expect(html).toContain('Add to theme')

    // No decorative disabled checkboxes standing in for status.
    expect(html).not.toMatch(/<input[^>]*type="checkbox"/)
  })

  it('marks every step Done once the guide is fully complete, but keeps the theme action reachable', () => {
    const html = renderToStaticMarkup(
      React.createElement(SetupGuide, {
        modelCount: 2,
        mappingCount: 3,
        liveCount: 1,
        themeUrl: 'https://admin.shopify.com/theme',
      }),
    )

    expect(html).toContain('3 out of 3 steps completed.')
    expect(html.match(/Done/g)).toHaveLength(3)

    // liveCount > 0 only means the block has been seen once -- it is not
    // proof the block is still installed, so the theme step must keep its
    // action even after it is marked Done (regression guard for a merchant
    // whose block was later removed from the theme).
    expect(html).toContain('Manage in theme editor')
  })
})
