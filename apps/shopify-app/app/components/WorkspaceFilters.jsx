/* eslint-disable react/prop-types -- plain JSX component, no PropTypes library in use */

const FILTERS = [
  { id: 'all', label: 'All products', countKey: 'all' },
  { id: 'live', label: 'Live', countKey: 'live' },
  { id: 'needs-attention', label: 'Needs attention', countKey: 'needsAttention' },
]

export default function WorkspaceFilters({
  counts,
  status,
  query,
  onStatusChange,
  onQueryChange,
}) {
  return (
    <s-stack direction="block" gap="base">
      <div
        className="workspace-summary"
        role="group"
        aria-label="Filter products by status"
      >
        {FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            className="workspace-filter"
            aria-pressed={status === filter.id}
            onClick={() => onStatusChange(filter.id)}
          >
            <span>{filter.label}</span>
            <strong>{counts[filter.countKey]}</strong>
          </button>
        ))}
      </div>
      {/* `label` + labelAccessibilityVisibility, not aria-label: on a Polaris
          custom element aria-label sits on the wrapper and does not reliably
          reach the inner input, so the field could reach screen readers with
          no accessible name. Same pattern as the Models page rename field. */}
      <s-text-field
        type="search"
        value={query}
        label="Search products and models"
        labelAccessibilityVisibility="exclusive"
        placeholder="Search products and models"
        onInput={(event) => onQueryChange(event.currentTarget.value)}
      ></s-text-field>
    </s-stack>
  )
}
