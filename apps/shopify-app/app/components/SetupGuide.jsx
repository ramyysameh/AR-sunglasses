/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */
import TopLevelAdminAction from './TopLevelAdminAction'

// Pure derivation: no React, no loader access. Counts and themeUrl are
// loader-owned and passed in by the route.
export function buildSetupSteps({ modelCount, mappingCount, liveCount, themeUrl }) {
  return [
    {
      id: 'model',
      label: 'Upload a model',
      description: modelCount ? `${modelCount} uploaded` : 'Add a GLB eyewear model.',
      done: modelCount > 0,
      actionLabel: 'Upload model',
      href: '/app/models',
    },
    {
      id: 'product',
      label: 'Add try-on to a product',
      description: mappingCount ? `${mappingCount} products configured` : 'Connect a product to a model.',
      done: mappingCount > 0,
      actionLabel: 'Add try-on',
      href: '/app/products',
    },
    {
      id: 'theme',
      label: 'Add the button to your theme',
      description: liveCount ? 'Try-on has been seen on your storefront.' : 'Enable the AR Try-On app block.',
      done: liveCount > 0,
      actionLabel: liveCount ? 'Manage in theme editor' : 'Add to theme',
      href: themeUrl,
      target: '_top',
    },
  ]
}

// The next useful thing for the merchant to do: the first incomplete step,
// or (once everything is done) a way back into day-to-day management.
export function nextSetupAction(steps) {
  return steps.find((step) => !step.done) ?? {
    actionLabel: 'Manage products',
    href: '/app/products',
  }
}

export default function SetupGuide({ modelCount, mappingCount, liveCount, themeUrl, steps: stepsProp }) {
  // The route already derives `steps` once (for buildSetupSteps + nextSetupAction
  // together); accept a precomputed `steps` prop to avoid recomputing it here,
  // while still accepting raw counts directly (e.g. from tests).
  const steps = stepsProp ?? buildSetupSteps({ modelCount, mappingCount, liveCount, themeUrl })
  const doneCount = steps.filter((step) => step.done).length
  const currentStep = steps.find((step) => !step.done)

  return (
    <s-section heading="Set up try-on">
      <s-paragraph color="subdued">
        {doneCount} out of {steps.length} steps completed.
      </s-paragraph>
      <s-stack direction="block" gap="base">
        {steps.map((step) => {
          const isCurrent = currentStep?.id === step.id
          // The theme step's action stays reachable even once "done": liveCount
          // is a "seen at least once" signal, not proof the app block is still
          // installed, so a merchant whose block was later removed from the
          // theme must still have a way back into the theme editor from here.
          const showAction = !step.done || step.id === 'theme'
          return (
            <s-box
              key={step.id}
              padding="base"
              borderRadius="base"
              background={isCurrent ? 'subdued' : undefined}
            >
              <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-badge tone={step.done ? 'success' : 'neutral'}>
                    {step.done ? 'Done' : 'To do'}
                  </s-badge>
                  <s-stack direction="block" gap="small-200">
                    <s-text type="strong">{step.label}</s-text>
                    {!step.done && <s-text color="subdued">{step.description}</s-text>}
                  </s-stack>
                </s-stack>
                {showAction && (
                  // Only the theme step's target is "_top" -- an admin URL
                  // that cannot be embedded in this app's iframe. A plain
                  // <s-button href target="_top"> is not a reliable break-out
                  // (App Bridge intercepts navigation from Polaris s-*
                  // components -- see TopLevelAdminAction.jsx's own comment),
                  // so that case gets the shared control instead; every other
                  // step is a plain in-app route and stays a plain <s-button>.
                  step.target === '_top' ? (
                    <TopLevelAdminAction
                      variant={isCurrent ? 'primary' : 'secondary'}
                      href={step.href}
                      accessibilityLabel={step.actionLabel}
                    >
                      {step.actionLabel}
                    </TopLevelAdminAction>
                  ) : (
                    <s-button
                      variant={isCurrent ? 'primary' : 'secondary'}
                      href={step.href}
                      accessibilityLabel={step.actionLabel}
                    >
                      {step.actionLabel}
                    </s-button>
                  )
                )}
              </s-stack>
              {step.id !== 'theme' && <s-divider />}
            </s-box>
          )
        })}
      </s-stack>
    </s-section>
  )
}
