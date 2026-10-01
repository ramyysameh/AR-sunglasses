import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ModelViewer, { ExpandedViewer } from '../app/components/ModelViewer.jsx'

global.React = React

const render = (props) => renderToStaticMarkup(React.createElement(ModelViewer, { src: '/m.glb', ...props }))

describe('ModelViewer', () => {
  it('defaults to a 160px viewer with no expand button', () => {
    const html = render({})
    expect(html).toContain('height:160px')
    expect(html).not.toContain('Open large preview')
  })

  it('offers a large preview when expandable', () => {
    const html = render({ height: 320, expandable: true })
    expect(html).toContain('height:320px')
    expect(html).toContain('aria-label="Open large preview"')
    expect(html).not.toContain('Zoom in')
  })
})

describe('ExpandedViewer', () => {
  const html = (canFullscreen) => renderToStaticMarkup(React.createElement(ExpandedViewer, {
    src: '/m.glb', alt: 'Aviator', canFullscreen, onClose: () => {}, onFullscreen: () => {},
  }))

  it('shows a zoomable viewer with a close button', () => {
    const out = html(false)
    expect(out).toContain('<model-viewer')
    expect(out).toContain('src="/m.glb"')
    expect(out).toContain('camera-controls')
    expect(out).not.toContain('disable-zoom')
    expect(out).toContain('aria-label="Close large preview"')
    expect(out).toContain('Drag to rotate. Scroll or pinch to zoom.')
  })

  it('offers full screen only when the browser allows it', () => {
    expect(html(true)).toContain('aria-label="Full screen"')
    expect(html(false)).not.toContain('aria-label="Full screen"')
  })
})
