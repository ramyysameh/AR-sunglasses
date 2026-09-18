import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

global.React = React

import ProductIndex, {
  ProductIndexView,
  ProductTable,
  filterMappings,
  sortMappings,
  paginateMappings,
  PAGE_SIZE,
} from '../app/components/ProductIndex.jsx'

// Array.from({ length: n }, mapping) factory -- (value, index) signature so it
// can be used directly as the map function, per the brief's pagination test.
function mapping(_value, index = 0) {
  return {
    id: `mapping-${index}`,
    productId: `gid://shopify/Product/${index}`,
    modelAssetId: 'model-a',
    modelAsset: { id: 'model-a', label: 'Frame' },
    product: { title: `Product ${index}`, imageUrl: null, imageAlt: null },
    status: { id: 'live', label: 'Live', tone: 'success' },
    previewUrl: null,
    qr: null,
    createdAt: new Date(2024, 0, index + 1).toISOString(),
  }
}

function statusOf(id) {
  return {
    live: { id: 'live', label: 'Live', tone: 'success' },
    check_fit: { id: 'check_fit', label: 'Check fit', tone: 'warning' },
    not_on_theme: { id: 'not_on_theme', label: 'Not on your theme yet', tone: 'warning' },
  }[id]
}

// Minimal props a ProductTable/ProductIndexView call needs beyond the ones a
// given test cares about -- kept in one place so each test only spells out
// what it's actually exercising.
function tableProps(overrides = {}) {
  return {
    items: [],
    totalPages: 1,
    hasPreviousPage: false,
    hasNextPage: false,
    query: '',
    status: 'all',
    sort: 'newest',
    onQueryChange: vi.fn(),
    onStatusChange: vi.fn(),
    onSortChange: vi.fn(),
    onClearFilters: vi.fn(),
    themeUrl: 'https://admin.shopify.com/theme',
    onChangeModel: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  }
}

// Walks a returned React element tree (plain objects with .type/.props, as
// returned by calling a hook-free component function directly -- same
// pattern the codebase already uses for ModelPicker) looking for the first
// element matching `predicate`.
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

describe('filterMappings', () => {
  const mappings = [
    {
      id: 'mapping-1',
      product: { title: 'Aviator Classic' },
      modelAsset: { id: 'model-a', label: 'Frame One' },
      status: statusOf('live'),
    },
    {
      id: 'mapping-2',
      product: { title: 'Round Frame' },
      modelAsset: { id: 'model-b', label: 'Frame Two' },
      status: statusOf('check_fit'),
    },
    {
      id: 'mapping-3',
      product: { title: 'Square Frame' },
      modelAsset: { id: 'model-c', label: 'Frame Three' },
      status: statusOf('not_on_theme'),
    },
  ]

  it('matches the product title case-insensitively', () => {
    expect(filterMappings(mappings, { query: 'aviator', status: 'all' }).map((m) => m.id))
      .toEqual(['mapping-1'])
    expect(filterMappings(mappings, { query: 'AVIATOR', status: 'all' }).map((m) => m.id))
      .toEqual(['mapping-1'])
  })

  it('matches the model name case-insensitively', () => {
    const withModelMatch = [
      ...mappings,
      {
        id: 'mapping-4',
        product: { title: 'Wayfarer' },
        modelAsset: { id: 'model-d', label: 'Retro Aviator Mold' },
        status: statusOf('live'),
      },
    ]
    expect(filterMappings(withModelMatch, { query: 'aviator', status: 'all' }).map((m) => m.id))
      .toEqual(['mapping-1', 'mapping-4'])
  })

  it.each([
    ['all', ['mapping-1', 'mapping-2', 'mapping-3']],
    ['live', ['mapping-1']],
    ['check_fit', ['mapping-2']],
    ['not_on_theme', ['mapping-3']],
  ])('filters by status %s', (status, expected) => {
    expect(filterMappings(mappings, { query: '', status }).map((m) => m.id)).toEqual(expected)
  })

  it('returns no matches when nothing satisfies query and status together', () => {
    expect(filterMappings(mappings, { query: 'aviator', status: 'check_fit' })).toEqual([])
  })
})

describe('sortMappings', () => {
  it('sorts by title case-insensitively and stably', () => {
    const mappings = [
      { id: 'a', product: { title: 'banana' }, status: statusOf('live') },
      { id: 'b', product: { title: 'Apple' }, status: statusOf('live') },
      { id: 'c', product: { title: 'apple' }, status: statusOf('live') },
    ]
    // 'b' and 'c' tie on title (case-insensitive) -- stable sort keeps 'b' before 'c'.
    expect(sortMappings(mappings, 'title').map((m) => m.id)).toEqual(['b', 'c', 'a'])
  })

  it('sorts by status, attention-needed first, stably within a status', () => {
    const mappings = [
      { id: 'a', product: { title: 'A' }, status: statusOf('live') },
      { id: 'b', product: { title: 'B' }, status: statusOf('check_fit') },
      { id: 'c', product: { title: 'C' }, status: statusOf('not_on_theme') },
      { id: 'd', product: { title: 'D' }, status: statusOf('check_fit') },
    ]
    expect(sortMappings(mappings, 'status').map((m) => m.id)).toEqual(['b', 'd', 'c', 'a'])
  })

  it('does not mutate the input array', () => {
    const mappings = [
      { id: 'a', product: { title: 'B' }, status: statusOf('live') },
      { id: 'b', product: { title: 'A' }, status: statusOf('live') },
    ]
    const original = [...mappings]
    sortMappings(mappings, 'title')
    expect(mappings).toEqual(original)
  })
})

describe('paginateMappings', () => {
  it('slices a page and reports pagination state (brief example)', () => {
    expect(paginateMappings(Array.from({ length: 41 }, mapping), 3, 20)).toMatchObject({
      items: expect.any(Array),
      page: 3,
      totalPages: 3,
      hasPreviousPage: true,
      hasNextPage: false,
    })
  })

  it('returns exactly PAGE_SIZE items per full page and the remainder on the last page', () => {
    const result = paginateMappings(Array.from({ length: 41 }, mapping), 1, PAGE_SIZE)
    expect(result.items).toHaveLength(20)
    expect(result.hasPreviousPage).toBe(false)
    expect(result.hasNextPage).toBe(true)

    const last = paginateMappings(Array.from({ length: 41 }, mapping), 3, PAGE_SIZE)
    expect(last.items).toHaveLength(1)
  })

  it('clamps the requested page down to the last valid page after filtering shrinks the set', () => {
    // Simulates: merchant was on page 3, then a filter/search narrows the
    // result set to a single page -- must not return an empty page.
    const small = Array.from({ length: 5 }, mapping)
    const result = paginateMappings(small, 3, PAGE_SIZE)
    expect(result.page).toBe(1)
    expect(result.totalPages).toBe(1)
    expect(result.items).toHaveLength(5)
    expect(result.hasPreviousPage).toBe(false)
    expect(result.hasNextPage).toBe(false)
  })

  it('clamps a page below 1 up to page 1', () => {
    const result = paginateMappings(Array.from({ length: 5 }, mapping), 0, PAGE_SIZE)
    expect(result.page).toBe(1)
  })

  it('exports PAGE_SIZE as 20', () => {
    expect(PAGE_SIZE).toBe(20)
  })
})

describe('ProductIndex responsive markup', () => {
  it('renders the filters slot, search field, pagination, mobile list slots, and heading', () => {
    const mappings = Array.from({ length: 25 }, mapping)
    const html = renderToStaticMarkup(
      React.createElement(ProductIndex, {
        mappings,
        themeUrl: 'https://admin.shopify.com/theme',
        onChangeModel: vi.fn(),
        onRemove: vi.fn(),
      }),
    )

    expect(html).toContain('slot="filters"')
    expect(html).toContain('s-search-field')
    expect(html).toContain('paginate=""')
    expect(html).toContain('listSlot="primary"')
    expect(html).toContain('listSlot="labeled"')
    expect(html).toContain('listSlot="secondary"')
    expect(html).toContain('heading="Products with try-on"')
    // s-empty-state is not a registered component in this app's pinned
    // Polaris version -- must never appear in the output (Critical 1 fix).
    expect(html).not.toContain('s-empty-state')
  })

  it('wraps the responsive filters grid in a query container', () => {
    // Every responsive-value example in Shopify's docs wraps the querying
    // element in <s-query-container> ("Wrap your content in
    // <s-query-container> to enable responsive value queries. By default,
    // queries target the closest container.") QueryContainer is the only
    // component that sets the `s-default` container-name an @container
    // condition resolves against -- without this wrapper the grid's
    // @container query has no container to match, and per CSS containment
    // semantics neither branch value reliably applies (i.e. the filters row
    // silently breaks at every width, not just under 700px). This asserts
    // on the element tree, not the string.toContain('slot="filters"')
    // check above, because that substring matches regardless of which
    // element in the tree carries the slot -- it would pass identically if
    // this wrapper were removed and `slot="filters"` moved back onto the
    // grid directly.
    const tree = ProductTable(tableProps())
    const children = Array.isArray(tree.props.children) ? tree.props.children : [tree.props.children]
    const tableElement = children.find((child) => child && child.type === 's-table')
    const queryContainer = findElement(tableElement, (node) => node.type === 's-query-container')

    expect(queryContainer).toBeTruthy()
    expect(queryContainer.props.slot).toBe('filters')

    const grid = findElement(queryContainer, (node) => node.type === 's-grid')
    expect(grid).toBeTruthy()
    // The slot assignment lives on the query-container now, not the grid.
    expect(grid.props.slot).toBeUndefined()
    expect(grid.props.gridTemplateColumns).toContain('@container')
  })

  it('binds search and select filters with onInput, not onChange (React 18 dispatch)', () => {
    // React never serializes event-handler props into SSR markup (neither
    // onChange nor onInput appears in the HTML string either way), so this
    // has to be checked on the element tree itself, not by string-matching
    // rendered output.
    const tree = ProductTable(tableProps())
    const children = Array.isArray(tree.props.children) ? tree.props.children : [tree.props.children]
    const tableElement = children.find((child) => child && child.type === 's-table')
    const grid = findElement(tableElement, (node) => node.type === 's-grid')
    const searchField = findElement(grid, (node) => node.type === 's-search-field')
    const selects = []
    findElement(grid, (node) => {
      if (node.type === 's-select') selects.push(node)
      return false
    })

    // React 18's ChangeEventPlugin only special-cases native <select> and
    // <input type=file> when deciding whether to dispatch a synthetic
    // `change` event -- an arbitrary custom element never qualifies, so
    // onChange here would silently never fire. `input` is a simple,
    // type-agnostic DOM event React forwards regardless of tag name.
    expect(typeof searchField.props.onInput).toBe('function')
    expect(searchField.props.onChange).toBeUndefined()
    expect(selects).toHaveLength(2)
    for (const select of selects) {
      expect(typeof select.props.onInput).toBe('function')
      expect(select.props.onChange).toBeUndefined()
    }
  })

  // Important-2 fix: the "Add to theme" recovery link used to be a raw
  // <a href target="_top" rel="noreferrer">, carrying no icon and no
  // accessibilityLabel. It's now TopLevelAdminAction, for consistency with
  // every other Shopify-admin destination in this app (Minor-9 coverage:
  // assert the actual control, not just its visible text).
  it('renders a not-on-theme row\'s "Add to theme" action as TopLevelAdminAction, not a raw anchor', () => {
    const notOnTheme = {
      ...mapping(undefined, 0),
      status: { id: 'not_on_theme', label: 'Not on your theme yet', tone: 'warning' },
    }
    const html = renderToStaticMarkup(
      React.createElement(ProductIndex, {
        mappings: [notOnTheme],
        themeUrl: 'https://admin.shopify.com/theme',
        onChangeModel: vi.fn(),
        onRemove: vi.fn(),
      }),
    )

    expect(html).toContain('Add to theme')
    expect(html).toContain('accessibilityLabel="Add try-on to your theme"')
    expect(html).toContain('icon="external"')
    expect(html).not.toMatch(/<a[^>]+href="https:\/\/admin\.shopify\.com[^>]*>/)
  })

  it('does not render pagination controls when everything fits on one page', () => {
    const mappings = Array.from({ length: 5 }, mapping)
    const html = renderToStaticMarkup(
      React.createElement(ProductIndex, {
        mappings,
        themeUrl: 'https://admin.shopify.com/theme',
        onChangeModel: vi.fn(),
        onRemove: vi.fn(),
      }),
    )

    // Tightened from not.toContain('paginate=""'): that alone would still
    // pass if the impl regressed to `paginate="false"` -- a real boolean
    // stringified onto a custom element, which a browser reads as *present*
    // (i.e. still truthy) regardless of its text. Asserting no `paginate=`
    // attribute at all is what actually proves pagination is off.
    expect(html).not.toMatch(/paginate=/)
  })

  it('wires a ref onto s-table for the native previouspage/nextpage event listeners', () => {
    // s-table's pagination is real DOM events (previouspage/nextpage per
    // @shopify/polaris-types), not props a React 18 JSX attribute can bind
    // to -- so ProductIndex attaches them by hand via a ref (Critical 2 fix).
    // This can't be exercised end-to-end without a real DOM (this repo's
    // test environment has no jsdom -- the same is true of the pre-existing
    // useAfterHide/'afterhide' wiring this mirrors, which also has no
    // behavioral test), but a dropped `ref={tableRef}` is exactly the
    // regression that would silently break pagination again, so pin it
    // structurally: the ref passed in must land on the actual <s-table>.
    const tableRef = { current: null }
    const tree = ProductTable(tableProps({ tableRef }))
    const children = Array.isArray(tree.props.children) ? tree.props.children : [tree.props.children]
    const tableElement = children.find((child) => child && child.type === 's-table')
    // `ref` is stored on the element itself (element.ref), not inside
    // element.props -- React strips it from props for every element type
    // (host or component) and warns in dev if you try to read it there.
    expect(tableElement.ref).toBe(tableRef)
  })
})

describe('ProductIndex no-results state', () => {
  it('keeps the filter controls visible and offers Clear filters when nothing matches', () => {
    const html = renderToStaticMarkup(
      React.createElement('div', null, ProductIndexView(tableProps({
        items: [],
        query: 'nonexistent',
      }))),
    )

    // Filters must still be present -- this is not the route's first-use
    // empty state, which has no search/status/sort controls at all.
    expect(html).toContain('slot="filters"')
    expect(html).toContain('s-search-field')
    // Anchored to the rendered text node, not a substring that would also
    // match an attribute value like heading="..." -- s-empty-state's
    // `heading` attribute would have satisfied a bare .toContain() even
    // though it renders nothing visible (exactly Critical 1's failure mode).
    expect(html).toContain('>No products match these filters<')
    expect(html).toMatch(/>Clear filters</)
    expect(html).not.toContain('Upload a model to get started')
    expect(html).not.toContain('Add try-on to your first product')
  })

  it('renders rows and no empty-state copy when results exist', () => {
    const items = Array.from({ length: 2 }, mapping)
    const html = renderToStaticMarkup(
      React.createElement('div', null, ProductIndexView(tableProps({ items }))),
    )

    expect(html).not.toContain('No products match these filters')
    expect(html).toContain('Product 0')
    expect(html).toContain('Product 1')
  })

  it('calls onClearFilters when the Clear filters action is used', () => {
    const onClearFilters = vi.fn()
    const tree = ProductTable(tableProps({ items: [], query: 'nonexistent', onClearFilters }))
    const clearButton = findElement(tree, (node) => (
      node.type === 's-button' && node.props.children === 'Clear filters'
    ))

    expect(clearButton).toBeTruthy()
    clearButton.props.onClick()
    expect(onClearFilters).toHaveBeenCalledTimes(1)
  })
})
