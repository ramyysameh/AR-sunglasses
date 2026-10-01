/* eslint-disable react/prop-types -- loader-shaped data, same as PlanUsage */
import { usagePercent } from './PlanUsage'

/**
 * The free-AI-models meter for the Models page. Uses the same track/fill
 * classes as PlanUsage (styles/workspace.css).
 * @param {{allowance: {allowance: number|null, used: number, unlimited: boolean, freeRemaining: number|null}|null}} props
 */
export default function AiModelUsage({ allowance }) {
  if (!allowance) return null
  if (allowance.unlimited) {
    return <s-text color="subdued">Unlimited AI models · {allowance.used} created</s-text>
  }
  const shown = Math.min(allowance.used, allowance.allowance)
  const full = allowance.used >= allowance.allowance
  return (
    <s-stack direction="block" gap="small-200">
      <s-text type="strong">{shown} of {allowance.allowance} free AI models used</s-text>
      <div
        className="workspace-plan-track"
        role="progressbar"
        aria-label={`${shown} of ${allowance.allowance} free AI models used`}
        aria-valuemin={0}
        aria-valuemax={allowance.allowance}
        aria-valuenow={shown}
      >
        <div
          className={full ? 'workspace-plan-fill is-full' : 'workspace-plan-fill'}
          style={{ width: `${usagePercent({ used: allowance.used, limit: allowance.allowance })}%` }}
        />
      </div>
      {full && <s-text color="subdued">Free models used up, then $5 each, added to your Shopify bill.</s-text>}
    </s-stack>
  )
}
