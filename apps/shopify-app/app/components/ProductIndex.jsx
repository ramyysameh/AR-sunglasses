/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */
import { useEffect, useMemo, useState } from 'react'
import PreviewPanel from './PreviewPanel'
import StatusBadge from './StatusBadge'

// Loader-provided pages (10/40 except Pro) are small enough that
// client-side pagination is the right call here -- see the plan's ambiguity
// resolution. Exported so tests and the row-count assertions below share one
// source of truth.
export const PAGE_SIZE = 20

// Attention-needing statuses sort first so a merchant scanning by status
// triages the things that need them, not the things that already work.
// check_fit's user-facing LABEL changes in a later task; this id is stable.
const STATUS_SORT_PRIORITY = { check_fit: 0, not_on_theme: 1, live: 2 }

function modelName(a) {
  return a.label || a.filename || `Model ${a.id.slice(0, 8)}`
}

// Pure: which mappings match the current search + status filter. Search
// covers both the product title and the mapped model's display name, since a
// merchant may remember either one.
export function filterMappings(mappings, { query = '', status = 'all' } = {}) {
  const q = query.trim().toLowerCase()
  return mappings.filter((m) => {
    if (status !== 'all' && m.status?.id !== status) return false
    if (!q) return true
    const title = (m.product?.title ?? '').toLowerCase()
    const model = modelName(m.modelAsset ?? {}).toLowerCase()
    return title.includes(q) || model.includes(q)
  })
}

// Pure: order mappings for display. Array.prototype.sort is a stable sort in
// every engine this app runs on, so ties (same title, same status) keep
// their incoming relative order rather than shuffling on every render.
export function sortMappings(mappings, sort) {
  const sorted = [...mappings]
  if (sort === 'title') {
    sorted.sort((a, b) => (
      (a.product?.title ?? '').localeCompare(b.product?.title ?? '', undefined, { sensitivity: 'base' })
    ))
    return sorted
  }
  if (sort === 'status') {
    sorted.sort((a, b) => (
      (STATUS_SORT_PRIORITY[a.status?.id] ?? 99) - (STATUS_SORT_PRIORITY[b.status?.id] ?? 99)
    ))
    return sorted
  }
  // 'newest': the loader already returns mappings ordered newest-first, but
  // re-deriving from createdAt keeps this control correct even if a future
  // caller passes mappings in some other order.
  sorted.sort((a, b) => {
    const at = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0
    return bt - at
  })
  return sorted
}

// Pure: slice one page out of an already filtered+sorted list. Clamps the
// requested page into range so a page that only made sense before a filter
// narrowed the result set never renders empty.
export function paginateMappings(mappings, page, pageSize = PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(mappings.length / pageSize))
  const clampedPage = Math.min(Math.max(1, page), totalPages)
  const start = (clampedPage - 1) * pageSize
  return {
    items: mappings.slice(start, start + pageSize),
    page: clampedPage,
    totalPages,
    hasPreviousPage: clampedPage > 1,
    hasNextPage: clampedPage < totalPages,
  }
}

function ProductRow({ mapping: m, themeUrl, onChangeModel, onRemove }) {
  return (
    <s-table-row>
      <s-table-cell>
        <s-stack direction="inline" gap="small-500" alignItems="center">
          {m.product?.imageUrl && (
            <s-thumbnail src={m.product.imageUrl} alt={m.product.imageAlt ?? m.product.title} size="small"></s-thumbnail>
          )}
          <s-text type="strong">{m.product?.title ?? 'Product unavailable'}</s-text>
        </s-stack>
      </s-table-cell>
      <s-table-cell>{modelName(m.modelAsset)}</s-table-cell>
      <s-table-cell>
        <s-stack direction="inline" gap="small-500" alignItems="center">
          <StatusBadge status={m.status} />
          {m.status.id === 'not_on_theme' && (
            <a href={themeUrl} target="_top" rel="noreferrer">Add to theme</a>
          )}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="inline" gap="small-500">
          <s-button commandFor={`preview-${m.id}`} command="--show">
            Preview
          </s-button>
          <s-button
            variant="tertiary"
            icon="menu-vertical"
            accessibilityLabel={`Actions for ${m.product?.title ?? 'product'}`}
            commandFor={`actions-${m.id}`}
          ></s-button>
          <s-menu id={`actions-${m.id}`} accessibilityLabel={`Actions for ${m.product?.title ?? 'product'}`}>
            <s-button icon="edit" onClick={() => onChangeModel(m.id)}>
              Change model
            </s-button>
            <s-button icon="delete" tone="critical" onClick={() => onRemove(m.id)}>
              Remove try-on
            </s-button>
          </s-menu>
        </s-stack>
      </s-table-cell>
    </s-table-row>
  )
}

// The index-table shell: filters, sort, headers with their mobile list-slot
// assignments, rows for the current page, and the in-body empty state used
// when filters match nothing. No hooks -- everything it needs is a prop --
// so it (and its no-results branch) can be rendered directly in tests
// without having to drive the stateful ProductIndex through real events.
function ProductTable({
  items,
  totalPages,
  hasPreviousPage,
  hasNextPage,
  query,
  status,
  sort,
  onQueryChange,
  onStatusChange,
  onSortChange,
  onPreviousPage,
  onNextPage,
  onClearFilters,
  themeUrl,
  onChangeModel,
  onRemove,
}) {
  return (
    <s-table
      variant="auto"
      paginate={totalPages > 1 ? '' : undefined}
      hasPreviousPage={hasPreviousPage ? '' : undefined}
      hasNextPage={hasNextPage ? '' : undefined}
      onPreviousPage={onPreviousPage}
      onNextPage={onNextPage}
    >
      <s-grid slot="filters" gap="small-200" gridTemplateColumns="minmax(0, 1fr) auto auto">
        <s-search-field
          label="Search products"
          labelAccessibilityVisibility="exclusive"
          placeholder="Search products or models"
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
        ></s-search-field>
        <s-select label="Status" value={status} onChange={(event) => onStatusChange(event.currentTarget.value)}>
          <s-option value="all">All statuses</s-option>
          <s-option value="live">Live</s-option>
          <s-option value="check_fit">Review fit</s-option>
          <s-option value="not_on_theme">Not on theme</s-option>
        </s-select>
        <s-select label="Sort" value={sort} onChange={(event) => onSortChange(event.currentTarget.value)}>
          <s-option value="newest">Newest</s-option>
          <s-option value="title">Product title</s-option>
          <s-option value="status">Status</s-option>
        </s-select>
      </s-grid>
      <s-table-header-row>
        <s-table-header listSlot="primary">Product</s-table-header>
        <s-table-header listSlot="labeled">Model</s-table-header>
        <s-table-header listSlot="secondary">Status</s-table-header>
        <s-table-header>Actions</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {items.length === 0 ? (
          // Rendered by the table itself only when the body has no rows --
          // filters/search/sort above stay mounted and visible, so this is
          // never confusable with the route's first-use empty states (which
          // have no filter controls at all).
          <s-empty-state heading="No products match these filters">
            <s-text slot="subheading">Try a different search term or status filter.</s-text>
            <s-button slot="primary-action" onClick={onClearFilters}>Clear filters</s-button>
          </s-empty-state>
        ) : (
          items.map((m) => (
            <ProductRow key={m.id} mapping={m} themeUrl={themeUrl} onChangeModel={onChangeModel} onRemove={onRemove} />
          ))
        )}
      </s-table-body>
    </s-table>
  )
}

// Composes the table with its section heading and each visible row's preview
// modal. Also hook-free, for the same testability reason as ProductTable.
export function ProductIndexView(props) {
  const { items } = props
  return (
    <s-section heading="Products with try-on">
      <ProductTable {...props} />
      {items.map((m) => (
        <s-modal key={m.id} id={`preview-${m.id}`} heading={`Preview ${m.product?.title ?? 'try-on'}`}>
          <PreviewPanel mapping={m} />
        </s-modal>
      ))}
    </s-section>
  )
}

// The stateful surface the route mounts. Owns query/status/sort/page locally
// and derives the visible page with the pure helpers above; the route keeps
// ownership of everything outside "the table, its filters, and its
// no-results state" (page-level empty states, primary action, modals shared
// across rows).
export default function ProductIndex({ mappings, themeUrl, onChangeModel, onRemove }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [sort, setSort] = useState('newest')
  const [page, setPage] = useState(1)

  // A new search/status/sort should always land back on page 1 -- otherwise
  // a merchant filtering down to a handful of rows while sitting on page 3
  // would see nothing, even though paginateMappings would clamp them onto a
  // valid page on the very next render.
  useEffect(() => {
    setPage(1)
  }, [query, status, sort])

  const filtered = useMemo(() => filterMappings(mappings, { query, status }), [mappings, query, status])
  const sorted = useMemo(() => sortMappings(filtered, sort), [filtered, sort])
  const paged = useMemo(() => paginateMappings(sorted, page, PAGE_SIZE), [sorted, page])

  return (
    <ProductIndexView
      items={paged.items}
      totalPages={paged.totalPages}
      page={paged.page}
      hasPreviousPage={paged.hasPreviousPage}
      hasNextPage={paged.hasNextPage}
      query={query}
      status={status}
      sort={sort}
      onQueryChange={setQuery}
      onStatusChange={setStatus}
      onSortChange={setSort}
      onPreviousPage={() => setPage((value) => Math.max(1, value - 1))}
      onNextPage={() => setPage((value) => Math.min(paged.totalPages, value + 1))}
      onClearFilters={() => {
        setQuery('')
        setStatus('all')
      }}
      themeUrl={themeUrl}
      onChangeModel={onChangeModel}
      onRemove={onRemove}
    />
  )
}
