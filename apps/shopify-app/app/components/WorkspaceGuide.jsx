/* eslint-disable react/prop-types -- plain JSX component, no PropTypes library in use */
import TopLevelAdminAction from './TopLevelAdminAction'

export default function WorkspaceGuide({ guide, onAction }) {
  if (guide.kind === 'complete') {
    return (
      <s-stack direction="inline" gap="small-500" alignItems="center">
        <s-badge tone="success">Live</s-badge>
        <s-text type="strong">{guide.title}</s-text>
        <s-text color="subdued">{guide.detail}</s-text>
      </s-stack>
    )
  }

  const action = guide.action
  const isSetup = guide.kind === 'setup'

  return (
    <s-box
      padding="base"
      border="base"
      borderRadius="base"
    >
      <s-stack
        direction={isSetup ? 'block' : 'inline'}
        gap="base"
        alignItems="center"
        justifyContent={isSetup ? 'center' : 'space-between'}
      >
        <s-stack direction="block" gap="small-200">
          <s-heading>{guide.title}</s-heading>
          {guide.detail && <s-paragraph>{guide.detail}</s-paragraph>}
        </s-stack>
        {action && (action.href ? (
          // Theme editor and Managed Pricing are Shopify admin destinations and
          // are never embeddable in this app's iframe. An <s-button href
          // target="_top"> does not reliably break out -- App Bridge intercepts
          // navigation from Polaris s-* components -- and onAction() handles
          // only the dialog-opening ids, so these two actions previously did
          // nothing at all. TopLevelAdminAction navigates imperatively from a
          // click handler instead.
          <TopLevelAdminAction
            href={action.href}
            variant="primary"
            accessibilityLabel={action.label}
          >
            {action.label}
          </TopLevelAdminAction>
        ) : (
          <s-button
            variant="primary"
            {...(isSetup ? { className: 'workspace-setup-action' } : {})}
            onClick={() => onAction(action)}
          >
            {action.label}
          </s-button>
        ))}
      </s-stack>
    </s-box>
  )
}
