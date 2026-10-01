import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import AiProductSource from '../app/components/AiProductSource.jsx'

global.React = React

const product = (id, n, selected) => ({
  id,
  title: `Product ${id}`,
  images: Array.from({ length: n }, (_, i) => ({ id: `${id}-${i}`, thumbnailUrl: `https://cdn/${id}${i}.jpg`, altText: '' })),
  selected,
})
const render = (picked) => renderToStaticMarkup(React.createElement(AiProductSource, {
  picked, disabled: false, onChoose: () => {}, onToggle: () => {}, onRemove: () => {},
}))

describe('AiProductSource', () => {
  it('offers Choose products when nothing is picked', () => {
    expect(render([])).toContain('Choose products')
  })

  it('shows a row per product with its photos and a remove action', () => {
    const html = render([product('A', 5, ['A-0', 'A-1', 'A-2', 'A-3']), product('B', 4, ['B-0', 'B-1', 'B-2'])])
    expect(html).toContain('Product A')
    expect(html).toContain('Product B')
    expect(html).toContain('4 of 4 selected')
    expect(html).toContain('3 of 4 selected')
    expect(html).toContain('aria-label="Remove Product A"')
    expect(html).toContain('Change products')
  })

  it('marks a product with fewer than 3 photos as skipped', () => {
    const html = render([product('C', 2, ['C-0', 'C-1'])])
    expect(html).toContain('Needs at least 3 photos')
  })

  it('gives each photo toggle its product name', () => {
    const html = render([product('A', 3, ['A-0'])])
    expect(html).toContain('aria-label="Product A photo 1"')
    expect(html).toContain('aria-label="Product A photo 3"')
  })
})
