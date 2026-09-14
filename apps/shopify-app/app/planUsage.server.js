import { planLimit, pricingUrlFor } from './billing.server.js'

/**
 * What the merchant is told about their plan. Unlimited plans get no meter and
 * no upgrade prompt -- there is nothing to upgrade to.
 *
 * Comped shops need no special case: getActivePlanName already returns 'Pro'
 * for them, so they arrive here as an unlimited plan like any other.
 * @param {{ planName: string|null, used: number, shop: string }} input
 */
export function planUsage({ planName, used, shop }) {
  const limit = planLimit(planName)
  const unlimited = !Number.isFinite(limit)
  return {
    planName,
    used,
    limit,
    unlimited,
    atLimit: !unlimited && used >= limit,
    pricingUrl: unlimited ? null : pricingUrlFor(shop),
  }
}
