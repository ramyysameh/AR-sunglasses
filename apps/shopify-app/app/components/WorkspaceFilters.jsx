/* eslint-disable react/prop-types -- plain JSX component, no PropTypes library in use */

export const FILTERS = [
  { id: 'all', label: 'All products', countKey: 'all' },
  { id: 'live', label: 'Live', countKey: 'live' },
  { id: 'needs-attention', label: 'Needs attention', countKey: 'needsAttention' },
]

// The table's filter bar: search plus a status select, both native Polaris
// fields. This replaced three hand-built <button> "cards" with their own
// colors and focus styles. Polaris web components have no tabs or pressed
// buttons, and s-clickable-chip cannot announce which chip is selected, so a
// labelled s-select is the accessible single choice here.
//
// `slot` is passed only when this renders inside s-table (slot="filters").
// Anywhere else, a slot attribute that the parent's shadow root has no slot
// for would hide the whole bar.
export default function WorkspaceFilters({
  counts,
  status,
  query,
  onStatusChange,
  onQueryChange,
  slot,
}) {
  return (
    <s-grid
      {...(slot ? { slot } : {})}
      gridTemplateColumns="1fr auto"
      gap="small-200"
      alignItems="end"
    >
      <s-search-field
        value={query}
        label="Search products and models"
        labelAccessibilityVisibility="exclusive"
        placeholder="Search products and models"
        // onInput, not onChange: React 18 never dispatches `change` to a
        // custom element (see ModelPicker.jsx).
        onInput={(event) => onQueryChange(event.currentTarget.value)}
      ></s-search-field>
      <s-select
        label="Status"
        labelAccessibilityVisibility="exclusive"
        value={status}
        onInput={(event) => onStatusChange(event.currentTarget.value)}
      >
        {FILTERS.map((filter) => (
          // Spread, not selected={false}: React 18 writes booleans on custom
          // elements as attribute strings, and selected="false" still selects.
          <s-option key={filter.id} value={filter.id} {...(status === filter.id ? { selected: true } : {})}>
            {`${filter.label} (${counts[filter.countKey] ?? 0})`}
          </s-option>
        ))}
      </s-select>
    </s-grid>
  )
}
