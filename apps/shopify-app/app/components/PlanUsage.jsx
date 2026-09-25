/* eslint-disable react/prop-types -- loader-shaped data, same as the other workspace panels */
import TopLevelAdminAction from './TopLevelAdminAction'

/**
 * How full the meter is, 0-100. Clamped at both ends: `used` can exceed `limit`
 * when a plan is downgraded while mappings already exist, and a bar wider than
 * its track renders as overflow rather than "full".
 * @param {{used: number, limit: number}} usage
 */
export function usagePercent({ used, limit }) {
  if (!Number.isFinite(limit) || limit <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)))
}

/**
 * Plan name, product meter and upgrade action.
 *
 * Unlimited plans (Pro, and owner-comped shops, which planUsage resolves to Pro)
 * get no meter and no upgrade button: a bar against Infinity measures nothing and
 * there is no higher plan to move to. They still get the plan name and a count,
 * so the panel never reads as missing.
 * @param {{usage: {planName: string|null, used: number, limit: number, unlimited: boolean, atLimit: boolean, pricingUrl: string|null}}} props
 */
export default function PlanUsage({ usage }) {
  if (!usage) return null

  const planName = usage.planName ?? 'No plan'

  if (usage.unlimited) {
    return (
      <s-section accessibilityLabel="Plan usage">
        <s-stack direction="block" gap="small-200">
          <s-text type="strong">{planName}</s-text>
          <s-text color="subdued">
            {usage.used} {usage.used === 1 ? 'product' : 'products'} using try-on
          </s-text>
        </s-stack>
      </s-section>
    )
  }

  const remaining = Math.max(0, usage.limit - usage.used)

  return (
    <s-section accessibilityLabel="Plan usage">
      <s-stack direction="block" gap="base">
        <div className="workspace-plan-head">
          <s-stack direction="block" gap="small-200">
            <s-text type="strong">{planName}</s-text>
            <s-text color="subdued">
              {usage.used} / {usage.limit} products
            </s-text>
          </s-stack>
          {usage.pricingUrl && (
            <TopLevelAdminAction
              href={usage.pricingUrl}
              accessibilityLabel="Upgrade plan"
              variant="secondary"
            >
              Upgrade plan
            </TopLevelAdminAction>
          )}
        </div>
        <div
          className="workspace-plan-track"
          role="progressbar"
          aria-label={`${usage.used} of ${usage.limit} products used`}
          aria-valuemin={0}
          aria-valuemax={usage.limit}
          aria-valuenow={Math.min(usage.used, usage.limit)}
        >
          <div
            className={usage.atLimit ? 'workspace-plan-fill is-full' : 'workspace-plan-fill'}
            style={{ width: `${usagePercent(usage)}%` }}
          />
        </div>
        <s-text color="subdued">
          {remaining > 0
            ? `${remaining} ${remaining === 1 ? 'product' : 'products'} remaining`
            : 'Upgrade to add more products'}
        </s-text>
      </s-stack>
    </s-section>
  )
}
