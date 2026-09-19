import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import PlanUsage, { usagePercent } from '../app/components/PlanUsage.jsx'

global.React = React

function limited(overrides = {}) {
  return {
    planName: 'Growth',
    used: 10,
    limit: 40,
    unlimited: false,
    atLimit: false,
    pricingUrl: 'https://admin.shopify.com/store/demo/charges/ar-try-on/pricing_plans',
    ...overrides,
  }
}

function render(usage) {
  return renderToStaticMarkup(React.createElement(PlanUsage, { usage }))
}

describe('usagePercent', () => {
  it('scales used against limit', () => {
    expect(usagePercent({ used: 10, limit: 40 })).toBe(25)
    expect(usagePercent({ used: 0, limit: 10 })).toBe(0)
    expect(usagePercent({ used: 10, limit: 10 })).toBe(100)
  })

  it('clamps a used count that exceeds the limit after a downgrade', () => {
    expect(usagePercent({ used: 41, limit: 40 })).toBe(100)
  })

  it('returns 0 rather than NaN for an unlimited or zero limit', () => {
    expect(usagePercent({ used: 5, limit: Infinity })).toBe(0)
    expect(usagePercent({ used: 5, limit: 0 })).toBe(0)
  })
})

describe('PlanUsage on a limited plan', () => {
  it('shows the plan, the meter and an upgrade action', () => {
    const html = render(limited())
    expect(html).toContain('Growth')
    expect(html).toContain('10 / 40 products')
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuemax="40"')
    expect(html).toContain('aria-valuenow="10"')
    expect(html).toContain('aria-label="10 of 40 products used"')
    expect(html).toContain('width:25%')
    expect(html).toContain('30 products remaining')
    expect(html).toMatch(/<s-button[^>]*accessibilityLabel="Upgrade plan"/)
  })

  it('singularises a single remaining product', () => {
    expect(render(limited({ used: 39 }))).toContain('1 product remaining')
  })

  it('marks the bar full and swaps the copy at the limit', () => {
    const html = render(limited({ used: 40, atLimit: true }))
    expect(html).toContain('workspace-plan-fill is-full')
    expect(html).toContain('width:100%')
    expect(html).toContain('Upgrade to add more products')
    expect(html).not.toContain('products remaining')
  })

  it('omits the upgrade action when there is no pricing url', () => {
    const html = render(limited({ pricingUrl: null }))
    expect(html).toContain('role="progressbar"')
    expect(html).not.toContain('Upgrade plan')
  })

  it('falls back to "No plan" when the shop has no subscription', () => {
    expect(render(limited({ planName: null }))).toContain('No plan')
  })
})

describe('PlanUsage on an unlimited plan', () => {
  const pro = { planName: 'Pro', used: 7, limit: Infinity, unlimited: true, atLimit: false, pricingUrl: null }

  it('shows the plan and count but no meter and no upgrade', () => {
    const html = render(pro)
    expect(html).toContain('Pro')
    expect(html).toContain('7 products using try-on')
    // A bar against Infinity measures nothing, and there is no higher plan.
    expect(html).not.toContain('role="progressbar"')
    expect(html).not.toContain('Upgrade plan')
  })

  it('singularises a single product', () => {
    expect(render({ ...pro, used: 1 })).toContain('1 product using try-on')
  })
})

describe('PlanUsage without usage data', () => {
  it('renders nothing rather than throwing', () => {
    expect(render(undefined)).toBe('')
  })
})
