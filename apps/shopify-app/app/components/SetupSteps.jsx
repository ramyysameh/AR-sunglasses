/* eslint-disable react/prop-types -- loader-shaped data */
import TopLevelAdminAction from './TopLevelAdminAction'

const MARK = { done: '✓', current: '', upcoming: '' }

function StepHeader({ index, step }) {
  const done = step.state === 'done'
  return (
    <s-stack direction="inline" gap="small-200" alignItems="center">
      <span
        aria-hidden="true"
        style={{
          width: '24px', height: '24px', borderRadius: '50%', display: 'inline-grid', placeItems: 'center',
          fontSize: '13px', fontWeight: 650,
          background: done ? '#29845a' : step.state === 'current' ? '#303030' : '#e3e3e3',
          color: done || step.state === 'current' ? '#fff' : '#616161',
        }}
      >
        {MARK[step.state] || index + 1}
      </span>
      <s-text type="strong" {...(step.state === 'current' ? { 'aria-current': 'step' } : {})}>{step.title}</s-text>
      {done && <s-badge tone="success">Done</s-badge>}
    </s-stack>
  )
}

/**
 * The home page's guided setup: create models -> review and save -> turn try-on
 * on in the store. `children` is the Create with AI panel, shown while step 1
 * or 2 is current. Hidden once all three are done.
 */
export default function SetupSteps({ setup, embedUrl, storefrontUrl, aiEnabled, onUploadModel, onCheckAgain, children }) {
  if (!setup || setup.done) return null
  const [create, save, turnOn] = setup.steps
  const creating = create.state === 'current' || save.state === 'current'
  return (
    <s-section heading="Get try-on live in 3 steps">
      <s-stack direction="block" gap="base">
        <StepHeader index={0} step={create} />
        <StepHeader index={1} step={save} />
        {creating && (
          <s-stack direction="block" gap="small-200">
            {aiEnabled ? (
              <s-paragraph>
                Pick your products and we&apos;ll build their 3D models from the product photos. Saving a model adds try-on to its product.
              </s-paragraph>
            ) : (
              <s-paragraph>Upload a 3D model of your frame to get started.</s-paragraph>
            )}
            {aiEnabled && children}
            <s-stack direction="inline">
              <s-button variant={aiEnabled ? 'tertiary' : 'primary'} onClick={onUploadModel}>Upload a .glb model</s-button>
            </s-stack>
          </s-stack>
        )}
        <StepHeader index={2} step={turnOn} />
        {turnOn.state === 'current' && (
          <s-stack direction="block" gap="small-200">
            <s-paragraph>
              One switch adds the Try-on button to every product with a model. In the theme editor, click Save.
            </s-paragraph>
            <s-stack direction="inline" gap="small-200">
              <TopLevelAdminAction href={embedUrl} variant="primary" accessibilityLabel="Turn on try-on">
                Turn on try-on
              </TopLevelAdminAction>
              <TopLevelAdminAction href={storefrontUrl} variant="secondary" accessibilityLabel="View on your store">
                View on your store
              </TopLevelAdminAction>
              <s-button variant="tertiary" onClick={onCheckAgain}>Check again</s-button>
            </s-stack>
            <s-text color="subdued">
              We notice the button once a product page with try-on has been viewed. Open one with View on your store.
            </s-text>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  )
}
