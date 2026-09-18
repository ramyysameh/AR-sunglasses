/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */
import { useMemo, useState } from 'react'
import ModelViewer from './ModelViewer'

function modelName(a) {
  return a.label || a.filename || `Model ${a.id.slice(0, 8)}`
}

// Pure: which assets match a search query against the merchant-facing model
// name (never the raw filename or id) -- exported so tests can exercise it
// without mounting anything, matching ProductIndex.jsx's filterMappings.
export function filterModelAssets(assets, query) {
  const q = query.trim().toLowerCase()
  if (!q) return assets
  return assets.filter((asset) => modelName(asset).toLowerCase().includes(q))
}

// Hook-free presentational piece: one search field, one compact choice list,
// and exactly one preview -- for the selected asset only, never one per
// choice. Exported so node-environment tests can call it directly without a
// real DOM, the same reasoning as ProductTable in ProductIndex.jsx.
export function ModelPickerView({
  assets,
  filtered,
  value,
  query,
  onQueryChange,
  onChoiceChange,
  onClearSearch,
}) {
  const selected = assets.find((asset) => asset.id === value) ?? null

  return (
    <s-stack direction="block" gap="base">
      <s-search-field
        label="Search models"
        labelAccessibilityVisibility="exclusive"
        placeholder="Search models"
        value={query}
        // Not onChange: React 18 only dispatches synthetic `change` for
        // native <select>/<input type=file> (ChangeEventPlugin's
        // shouldUseChangeEvent), so it never fires on a custom element here.
        // `input` is a simple, type-agnostic DOM event React forwards
        // regardless of tag name, and it's the per-keystroke event per
        // Shopify's "Handling events" guide -- see ProductIndex.jsx's search
        // field for the same reasoning.
        onInput={(event) => onQueryChange(event.currentTarget.value)}
      ></s-search-field>
      {filtered.length === 0 ? (
        // Keeps the search field mounted and visible -- same principle as
        // ProductIndex's no-results state -- instead of collapsing the whole
        // picker to an empty list a merchant can't recover from.
        <s-stack direction="block" gap="base">
          <s-text type="strong">No models match your search</s-text>
          <s-paragraph color="subdued">Try a different search term.</s-paragraph>
          <s-button onClick={onClearSearch}>Clear search</s-button>
        </s-stack>
      ) : (
        <s-choice-list
          label="Choose a model"
          name="modelAssetId"
          values={value ? [value] : []}
          // This element pre-existed as onChange, which -- like the search
          // field above -- React 18 never dispatches to a custom element, so
          // selecting a model silently did nothing. Converting to onInput
          // (also documented for s-choice-list in @shopify/polaris-types)
          // fixes that pre-existing bug as part of owning this file.
          onInput={(event) => onChoiceChange(event.currentTarget.values[0] ?? '')}
        >
          {filtered.map((asset) => (
            <s-choice key={asset.id} value={asset.id} accessibilityLabel={`Use ${modelName(asset)}`}>
              {modelName(asset)}
            </s-choice>
          ))}
        </s-choice-list>
      )}
      {selected && (
        <s-box border="base" borderRadius="base" padding="base">
          <s-text type="strong">Selected model preview</s-text>
          <ModelViewer src={`/models/${selected.id}.glb`} alt={modelName(selected)} />
        </s-box>
      )}
    </s-stack>
  )
}

export default function ModelPicker({ assets, value, onChange }) {
  const [query, setQuery] = useState('')
  // Hooks must run unconditionally on every render -- computed before the
  // zero-assets early return below, even though its result is unused there.
  const filtered = useMemo(() => filterModelAssets(assets, query), [assets, query])

  if (assets.length === 0) {
    return (
      <s-paragraph>
        Upload a model on the <s-link href="/app/models">Models</s-link> page first.
      </s-paragraph>
    )
  }

  return (
    <ModelPickerView
      assets={assets}
      filtered={filtered}
      value={value}
      query={query}
      onQueryChange={setQuery}
      onChoiceChange={onChange}
      onClearSearch={() => setQuery('')}
    />
  )
}
