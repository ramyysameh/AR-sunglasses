import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

global.React = React

import ProductIndex, {
  ProductIndexView,
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

    expect(html).not.toContain('paginate=""')
  })
})

describe('ProductIndex no-results state', () => {
  it('keeps the filter controls visible and offers Clear filters when nothing matches', () => {
    const html = renderToStaticMarkup(
      React.createElement('div', null, ProductIndexView({
        items: [],
        totalPages: 1,
        page: 1,
        hasPreviousPage: false,
        hasNextPage: false,
        query: 'nonexistent',
        status: 'all',
        sort: 'newest',
        onQueryChange: vi.fn(),
        onStatusChange: vi.fn(),
        onSortChange: vi.fn(),
        onPreviousPage: vi.fn(),
        onNextPage: vi.fn(),
        onClearFilters: vi.fn(),
        themeUrl: 'https://admin.shopify.com/theme',
        onChangeModel: vi.fn(),
        onRemove: vi.fn(),
      })),
    )

    // Filters must still be present -- this is not the route's first-use
    // empty state, which has no search/status/sort controls at all.
    expect(html).toContain('slot="filters"')
    expect(html).toContain('s-search-field')
    expect(html).toContain('No products match these filters')
    expect(html).toMatch(/Clear filters/)
    expect(html).not.toContain('Upload a model to get started')
    expect(html).not.toContain('Add try-on to your first product')
  })

  it('renders rows and no empty-state copy when results exist', () => {
    const items = Array.from({ length: 2 }, mapping)
    const html = renderToStaticMarkup(
      React.createElement('div', null, ProductIndexView({
        items,
        totalPages: 1,
        page: 1,
        hasPreviousPage: false,
        hasNextPage: false,
        query: '',
        status: 'all',
        sort: 'newest',
        onQueryChange: vi.fn(),
        onStatusChange: vi.fn(),
        onSortChange: vi.fn(),
        onPreviousPage: vi.fn(),
        onNextPage: vi.fn(),
        onClearFilters: vi.fn(),
        themeUrl: 'https://admin.shopify.com/theme',
        onChangeModel: vi.fn(),
        onRemove: vi.fn(),
      })),
    )

    expect(html).not.toContain('No products match these filters')
    expect(html).toContain('Product 0')
    expect(html).toContain('Product 1')
  })
})
