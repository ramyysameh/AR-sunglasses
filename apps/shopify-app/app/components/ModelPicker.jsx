/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */
import ModelViewer from './ModelViewer'

function modelName(a) {
  return a.label || a.filename || `Model ${a.id.slice(0, 8)}`
}

// The point of this component: a merchant picks the frames they can SEE. The
// old <s-select> of "gripzpelmo.glb - Sep 7" labels asked them to choose blind
// while the previews sat in a different section of the page.
export default function ModelPicker({ assets, value, onChange }) {
  if (assets.length === 0) {
    return (
      <s-paragraph>
        Upload a model first -- then you can add try-on to a product.
      </s-paragraph>
    )
  }
  return (
    <s-grid gridTemplateColumns="1fr 1fr" gap="base">
      {assets.map((a) => (
        <s-box
          key={a.id}
          padding="base"
          borderWidth={value === a.id ? 'large' : 'base'}
          borderRadius="base"
          onClick={() => onChange(a.id)}
        >
          <s-stack direction="block" gap="small-500">
            <ModelViewer src={`/models/${a.id}.glb`} alt={modelName(a)} />
            <s-text type={value === a.id ? 'strong' : undefined}>{modelName(a)}</s-text>
          </s-stack>
        </s-box>
      ))}
    </s-grid>
  )
}
