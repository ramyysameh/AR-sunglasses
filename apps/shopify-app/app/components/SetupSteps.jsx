/* eslint-disable react/prop-types -- loader-shaped data */
import TopLevelAdminAction from './TopLevelAdminAction'

// A plain anchor so the storefront opens in a new tab (not the admin's top
// frame), styled like Polaris' secondary button.
const SECONDARY_LINK = {
  display: 'inline-flex', alignItems: 'center', padding: '6px 12px', borderRadius: '8px',
  border: '1px solid #8a8a8a', color: '#303030', background: '#fff', fontWeight: 550,
  fontSize: '13px', textDecoration: 'none',
}

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
 * on in the store. The Create with AI panel is NOT rendered here: it lives on
 * the page itself so it stays mounted (and keeps any in-flight bulk run) after
 * the first save moves setup past step 1. Hidden once all three are done.
 */
export default function SetupSteps({ setup, embedUrl, storefrontUrl, aiEnabled, onUploadModel, onCheckAgain }) {
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
                Use Create with AI below to build models from your product photos. Saving a model adds try-on to its product.
              </s-paragraph>
            ) : (
              <s-paragraph>
                {create.state === 'current'
                  ? 'Upload a 3D model of your frame to get started.'
                  : 'Add try-on to a product with your model.'}
              </s-paragraph>
            )}
            <s-stack direction="inline">
              <s-button variant={aiEnabled ? 'tertiary' : 'primary'} onClick={onUploadModel}>
                {!aiEnabled && create.state !== 'current' ? 'Add try-on' : 'Upload a .glb model'}
              </s-button>
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
              {storefrontUrl && (
                <a href={storefrontUrl} target="_blank" rel="noreferrer" style={SECONDARY_LINK}>
                  View on your store
                </a>
              )}
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
