import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import PreviewPanel from '../app/components/PreviewPanel.jsx'

vi.mock('../app/components/ModelViewer.jsx', () => ({
  default: ({ src, alt }) => React.createElement('div', {
    'data-model-src': src,
    'data-model-alt': alt,
  }),
}))

global.React = React

const assets = [
  { id: 'model-a', label: 'Aviator' },
  { id: 'model-b', label: 'Wayfarer' },
]

describe('shared product components', () => {
  // ModelPicker's own coverage moved to modelPicker.ui.test.js when the
  // compact, searchable picker replaced the bare choice list this file used
  // to assert (a single `s-choice-list` with an onChange prop). The picker is
  // now a hook-using component, so it cannot be called as a plain function
  // here, and its event binding is onInput -- onChange never fired on a
  // custom element under React 18 in the first place.

  it('previews the glasses model without composing it onto a mock head', () => {
    const mapping = {
      modelAssetId: 'model-a',
      modelAsset: assets[0],
      product: { title: 'Preview product' },
    }

    const html = renderToStaticMarkup(React.createElement(PreviewPanel, { mapping }))

    expect(html).toContain('data-model-src="/models/model-a.glb"')
    expect(html).not.toContain('fit-preview.glb')
    expect(html).not.toMatch(/reference head/i)
  })

  it('can keep an unpublished review free of a broken phone-preview warning', () => {
    const html = renderToStaticMarkup(React.createElement(PreviewPanel, {
      mapping: { modelAssetId: 'model-a' },
      showPhonePreview: false,
    }))

    expect(html).not.toContain('Phone preview unavailable')
    expect(html).not.toContain('Try it on your phone')
  })
})
