import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import ModelPicker from '../app/components/ModelPicker.jsx'
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
  it('uses a controlled model choice and reports the selected model', () => {
    const onChange = vi.fn()
    const picker = ModelPicker({ assets, value: 'model-b', onChange })

    expect(picker.type).toBe('s-choice-list')
    expect(picker.props.values).toEqual(['model-b'])

    picker.props.onChange({ currentTarget: { values: ['model-a'] } })
    expect(onChange).toHaveBeenCalledWith('model-a')
  })

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
