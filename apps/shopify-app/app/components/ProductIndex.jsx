/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */
import { useEffect, useMemo, useRef, useState } from 'react'
import PreviewPanel from './PreviewPanel'
import StatusBadge from './StatusBadge'
import TopLevelAdminAction from './TopLevelAdminAction'

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
    const model = modelName(m.modelAsset).toLowerCase()
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
            <TopLevelAdminAction href={themeUrl} variant="tertiary" accessibilityLabel="Add try-on to your theme">
              Add to theme
            </TopLevelAdminAction>
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
// assignments, rows for the current page, and the no-results message used
// when filters match nothing. No hooks -- everything it needs is a prop --
// so it (and its no-results branch, and the Clear filters action) can be
// rendered and driven directly in tests without having to push the stateful
// ProductIndex through real DOM events. Exported for that reason.
export function ProductTable({
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
  onClearFilters,
  themeUrl,
  onChangeModel,
  onRemove,
  tableRef,
}) {
  return (
    <>
      <s-table
        ref={tableRef}
        variant="auto"
        // React 18 has no custom-element property support and does not
        // special-case these tags in its change-event dispatch, so a boolean
        // `true`/`false` here would serialize to the literal attribute
        // string "true"/"false" -- which a real boolean-reflecting custom
        // element reads as present (i.e. always truthy) regardless of its
        // text. Only ever emit the attribute when true (empty string) and
        // omit it otherwise. Revisit this the day the app moves to React 19,
        // which sets matching DOM *properties* instead of attributes -- at
        // that point `element.paginate = ''` would itself be falsy and this
        // pattern would need to become a real boolean again.
        paginate={totalPages > 1 ? '' : undefined}
        hasPreviousPage={hasPreviousPage ? '' : undefined}
        hasNextPage={hasNextPage ? '' : undefined}
      >
        {/* Every responsive-value example in Shopify's docs (the Query
            container page, and the Grid/Box property docs it's linked from)
            wraps the querying element in <s-query-container> -- "Wrap your
            content in <s-query-container> to enable responsive value
            queries. By default, queries target the closest container."
            QueryContainer is the only component in polaris.d.ts that sets
            the `s-default` container-name an @container condition resolves
            against, so the grid can't carry a working @container value
            without this wrapper. `slot` moved here from the grid --
            ReactBaseElementProps (which every generated React element type,
            including QueryContainer's, extends via
            ReactBaseElementPropsWithChildren) declares `slot`, and Table's
            `filters` slot is typed as a generic ComponentChildren with no
            element-type restriction, so a query-container is a valid
            slotted child. */}
        <s-query-container slot="filters">
          <s-grid
            gap="small-200"
            // Responsive value syntax per Shopify's docs (using-polaris-web-components
            // #responsive-values / the query-container padding example):
            // `@container (<condition>) <value-if-true>, <value-if-false>`.
            // Below ~700px the two selects next to a search field are too
            // cramped (Global Constraint: usable at 320px), so stack to a
            // single column; above it, use the brief's 3-column row.
            gridTemplateColumns="@container (inline-size < 700px) 1fr, minmax(0, 1fr) auto auto"
          >
            <s-search-field
              label="Search products"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search products or models"
              value={query}
              // Not onChange: React 18 only dispatches synthetic `change` for
              // native <select>/<input type=file> elements (ChangeEventPlugin's
              // shouldUseChangeEvent), so it never fires on a custom element.
              // `input` is a simple, type-agnostic DOM event that React
              // forwards regardless of tag name, and Shopify's own "Handling
              // events" guide (using-polaris-web-components#handling-events)
              // documents onInput as the per-keystroke event on form
              // components -- exactly what live search needs anyway.
              onInput={(event) => onQueryChange(event.currentTarget.value)}
            ></s-search-field>
            <s-select label="Status" value={status} onInput={(event) => onStatusChange(event.currentTarget.value)}>
              <s-option value="all">All statuses</s-option>
              <s-option value="live">Live</s-option>
              <s-option value="check_fit">Review fit</s-option>
              <s-option value="not_on_theme">Not on theme</s-option>
            </s-select>
            <s-select label="Sort" value={sort} onInput={(event) => onSortChange(event.currentTarget.value)}>
              <s-option value="newest">Newest</s-option>
              <s-option value="title">Product title</s-option>
              <s-option value="status">Status</s-option>
            </s-select>
          </s-grid>
        </s-query-container>
        <s-table-header-row>
          <s-table-header listSlot="primary">Product</s-table-header>
          <s-table-header listSlot="labeled">Model</s-table-header>
          <s-table-header listSlot="secondary">Status</s-table-header>
          <s-table-header>Actions</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {items.map((m) => (
            <ProductRow key={m.id} mapping={m} themeUrl={themeUrl} onChangeModel={onChangeModel} onRemove={onRemove} />
          ))}
        </s-table-body>
      </s-table>
      {items.length === 0 && (
        // `s-empty-state` is not a registered component in this app's pinned
        // Polaris version (confirmed absent from @shopify/polaris-types
        // 1.0.1's polaris.d.ts) -- composed from supported primitives
        // instead, matching what the route already does for its own two
        // empty states. Rendered as a sibling of <s-table>, not inside
        // <s-table-body>, so the filters/search/sort above stay mounted and
        // visible.
        <s-stack direction="block" gap="base">
          <s-text type="strong">No products match these filters</s-text>
          <s-paragraph color="subdued">Try a different search term or status filter.</s-paragraph>
          <s-button onClick={onClearFilters}>Clear filters</s-button>
        </s-stack>
      )}
    </>
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
  const tableRef = useRef(null)

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

  // s-table exposes pagination as real DOM events -- `onpreviouspage`/
  // `onnextpage` per @shopify/polaris-types (polaris.d.ts), i.e. events named
  // `previouspage`/`nextpage` -- not as an onX prop a React 18 JSX attribute
  // binds to (React 18 has no custom-element property support and its event
  // dispatch doesn't special-case unknown elements, so onPreviousPage/
  // onNextPage props are silently stripped as attributes). Wire the real
  // events by hand, the same pattern useAfterHide already uses in the route
  // for <s-modal>'s `afterhide`.
  useEffect(() => {
    const table = tableRef.current
    if (!table) return undefined
    const handlePrevious = () => setPage((value) => Math.max(1, value - 1))
    const handleNext = () => setPage((value) => Math.min(paged.totalPages, value + 1))
    table.addEventListener('previouspage', handlePrevious)
    table.addEventListener('nextpage', handleNext)
    return () => {
      table.removeEventListener('previouspage', handlePrevious)
      table.removeEventListener('nextpage', handleNext)
    }
  }, [paged.totalPages])

  return (
    <ProductIndexView
      items={paged.items}
      totalPages={paged.totalPages}
      hasPreviousPage={paged.hasPreviousPage}
      hasNextPage={paged.hasNextPage}
      query={query}
      status={status}
      sort={sort}
      onQueryChange={setQuery}
      onStatusChange={setStatus}
      onSortChange={setSort}
      onClearFilters={() => {
        setQuery('')
        setStatus('all')
      }}
      themeUrl={themeUrl}
      onChangeModel={onChangeModel}
      onRemove={onRemove}
      tableRef={tableRef}
    />
  )
}
