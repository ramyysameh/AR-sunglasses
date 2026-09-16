/* eslint-disable react/prop-types -- plain JSX component, no PropTypes library in use */

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

  return (
    <s-box
      className="workspace-guide-panel"
      padding="base"
      border="base"
      borderRadius="base"
    >
      <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
        <s-stack direction="block" gap="small-200">
          <s-heading>{guide.title}</s-heading>
          {guide.detail && <s-paragraph>{guide.detail}</s-paragraph>}
        </s-stack>
        {action && (
          <s-button
            variant="primary"
            {...(action.href ? { href: action.href, target: '_top' } : {})}
            onClick={() => onAction(action)}
          >
            {action.label}
          </s-button>
        )}
      </s-stack>
    </s-box>
  )
}
