import { describe, it, expect } from 'vitest'
import { planUsage } from '../app/planUsage.server.js'

const shop = 'demo-shop.myshopify.com'

describe('planUsage', () => {
  it('reports used against the plan limit', () => {
    expect(planUsage({ planName: 'Starter', used: 4, shop }))
      .toMatchObject({ planName: 'Starter', used: 4, limit: 10, unlimited: false, atLimit: false })
  })

  it('flags being at the limit', () => {
    expect(planUsage({ planName: 'Starter', used: 10, shop })).toMatchObject({ atLimit: true })
  })

  it('treats an unlimited plan as unlimited with no upgrade prompt', () => {
    const usage = planUsage({ planName: 'Pro', used: 99, shop })
    expect(usage).toMatchObject({ unlimited: true, atLimit: false })
    expect(usage.pricingUrl).toBeNull()
  })

  it('offers a pricing URL on a capped plan', () => {
    expect(planUsage({ planName: 'Growth', used: 1, shop }).pricingUrl).toContain('/charges/')
  })

  // Comped shops need no special case here: getActivePlanName already returns
  // 'Pro' for them, so they arrive as an unlimited plan like any other. Do not
  // add a `comped` parameter -- it would be a branch that cannot be reached.
  it('reports zero limit for an unknown plan name', () => {
    // planLimit fails closed on a dashboard/code name mismatch.
    expect(planUsage({ planName: 'Mystery', used: 0, shop })).toMatchObject({ limit: 0, atLimit: true })
  })
})
