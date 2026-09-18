import { readFile } from 'node:fs/promises'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SetupGuide, { buildSetupSteps, nextSetupAction } from '../app/components/SetupGuide.jsx'

global.React = React

const routeUrl = new URL('../app/routes/app._index.jsx', import.meta.url)

describe('home Polaris contract', () => {
  it('uses valid subdued text and numeric ARIA values', async () => {
    const source = await readFile(routeUrl, 'utf8')
    expect(source).not.toContain('tone="subdued"')
    expect(source).not.toContain('aria-valuemin="0"')
    expect(source).toContain('color="subdued"')
    expect(source).toContain('aria-valuemin={0}')
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

    // Both incomplete steps (product, theme) still offer an action.
    expect(html).toContain('Add try-on')
    expect(html).toContain('Add to theme')

    // No decorative disabled checkboxes standing in for status.
    expect(html).not.toMatch(/<input[^>]*type="checkbox"/)
  })

  it('marks every step Done once the guide is fully complete', () => {
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
  })
})
