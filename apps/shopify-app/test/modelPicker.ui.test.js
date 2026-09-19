import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import ModelPicker, { filterModelAssets, ModelPickerView } from '../app/components/ModelPicker.jsx'

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

// Walks a returned React element tree (plain objects with .type/.props, as
// returned by calling a hook-free component function directly) looking for
// the first element matching `predicate`.
function findElement(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  const children = node.props?.children
  if (children === undefined) return null
  const list = Array.isArray(children) ? children : [children]
  for (const child of list) {
    const found = findElement(child, predicate)
    if (found) return found
  }
  return null
}

// These cover the compact, searchable ModelPicker. They used to live in
// appProducts.ui.test.js; that file became upstream's "shared product
// components" suite during the workspace merge, so the picker's own coverage
// moved here rather than being lost. The behaviors below are the ones the
// picker exists to guarantee -- search that never mounts a viewer per choice,
// React-18-correct event binding, and a recoverable no-results state.
describe('ModelPicker', () => {
  it('filters model names without mounting one viewer per choice', () => {
    // The SSR assertion relies on ModelViewer mounting the real
    // <model-viewer> custom element only after intersection + a dynamic
    // import that never resolves during SSR, so the mocked marker stands in
    // as a per-instance count: exactly one means exactly one ModelViewer was
    // mounted, for the selected asset only, never one per choice.
    expect(filterModelAssets(assets, 'way')).toEqual([assets[1]])
    const html = renderToStaticMarkup(
      React.createElement(ModelPicker, { assets, value: 'model-b', onChange: vi.fn() }),
    )
    expect(html).toContain('s-search-field')
    expect(html.match(/<model-viewer/g) ?? []).toHaveLength(0)
    expect(html.match(/data-model-src/g)).toHaveLength(1)
  })

  it('is case-insensitive and returns every asset for an empty query', () => {
    expect(filterModelAssets(assets, 'WAY')).toEqual([assets[1]])
    expect(filterModelAssets(assets, '')).toEqual(assets)
    expect(filterModelAssets(assets, '   ')).toEqual(assets)
    expect(filterModelAssets(assets, 'zzz')).toEqual([])
  })

  it('binds the search field and choice list with onInput, not onChange (React 18 dispatch)', () => {
    // React 18's ChangeEventPlugin only special-cases native <select>/<input
    // type=file> when deciding whether to dispatch a synthetic `change`
    // event -- an arbitrary custom element never qualifies, so onChange here
    // would silently never fire. `input` is a simple, type-agnostic DOM event
    // React forwards regardless of tag name.
    const tree = ModelPickerView({
      assets,
      filtered: assets,
      value: 'model-b',
      query: '',
      onQueryChange: vi.fn(),
      onChoiceChange: vi.fn(),
      onClearSearch: vi.fn(),
    })
    const searchField = findElement(tree, (node) => node.type === 's-search-field')
    const choiceList = findElement(tree, (node) => node.type === 's-choice-list')

    expect(typeof searchField.props.onInput).toBe('function')
    expect(searchField.props.onChange).toBeUndefined()
    expect(typeof choiceList.props.onInput).toBe('function')
    expect(choiceList.props.onChange).toBeUndefined()
  })

  it('reports the selected model through the onChange prop when a choice fires input', () => {
    const onChange = vi.fn()
    const tree = ModelPickerView({
      assets,
      filtered: assets,
      value: 'model-b',
      query: '',
      onQueryChange: vi.fn(),
      onChoiceChange: onChange,
      onClearSearch: vi.fn(),
    })
    const choiceList = findElement(tree, (node) => node.type === 's-choice-list')

    choiceList.props.onInput({ currentTarget: { values: ['model-a'] } })
    expect(onChange).toHaveBeenCalledWith('model-a')
  })

  it('keeps the search field visible and offers Clear search when nothing matches', () => {
    const onClearSearch = vi.fn()
    const html = renderToStaticMarkup(
      React.createElement('div', null, ModelPickerView({
        assets,
        filtered: [],
        value: 'model-b',
        query: 'zzz',
        onQueryChange: vi.fn(),
        onChoiceChange: vi.fn(),
        onClearSearch,
      })),
    )

    expect(html).toContain('s-search-field')
    expect(html).toContain('>No models match your search<')
    expect(html).toMatch(/>Clear search</)

    const tree = ModelPickerView({
      assets,
      filtered: [],
      value: 'model-b',
      query: 'zzz',
      onQueryChange: vi.fn(),
      onChoiceChange: vi.fn(),
      onClearSearch,
    })
    const clearButton = findElement(tree, (node) => (
      node.type === 's-button' && node.props.children === 'Clear search'
    ))

    expect(clearButton).toBeTruthy()
    clearButton.props.onClick()
    expect(onClearSearch).toHaveBeenCalledTimes(1)
  })
})
