/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */
import ModelViewer from './ModelViewer'

function modelName(a) {
  return a.label || a.filename || `Model ${a.id.slice(0, 8)}`
}

export default function ModelPicker({ assets, value, onChange }) {
  if (assets.length === 0) {
    return (
      <s-paragraph>
        Upload a model on the <s-link href="/app/models">Models</s-link> page first.
      </s-paragraph>
    )
  }

  return (
    <s-choice-list
      label="Choose a model"
      name="modelAssetId"
      values={value ? [value] : []}
      onChange={(event) => onChange(event.currentTarget.values[0] ?? '')}
    >
      {assets.map((a) => (
        <s-choice key={a.id} value={a.id} accessibilityLabel={`Use ${modelName(a)}`}>
          {modelName(a)}
          <s-stack slot="details" direction="block" gap="small-500">
            <ModelViewer src={`/models/${a.id}.glb`} alt={modelName(a)} />
            {value === a.id && <s-badge tone="success">Selected</s-badge>}
          </s-stack>
        </s-choice>
      ))}
    </s-choice-list>
  )
}
