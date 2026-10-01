import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ModelViewer, { zoomStep } from '../app/components/ModelViewer.jsx'

global.React = React

const render = (props) => renderToStaticMarkup(React.createElement(ModelViewer, { src: '/m.glb', ...props }))

describe('ModelViewer', () => {
  it('defaults to a 160px viewer without zoom buttons', () => {
    const html = render({})
    expect(html).toContain('height:160px')
    expect(html).not.toContain('Zoom in')
  })

  it('renders zoom in, zoom out and reset buttons when asked', () => {
    const html = render({ height: 320, controls: true })
    expect(html).toContain('height:320px')
    expect(html).toContain('aria-label="Zoom in"')
    expect(html).toContain('aria-label="Zoom out"')
    expect(html).toContain('aria-label="Reset view"')
  })

  it('maps zoom directions to model-viewer key presses', () => {
    expect(zoomStep('in')).toBe(1)
    expect(zoomStep('out')).toBe(-1)
  })
})
