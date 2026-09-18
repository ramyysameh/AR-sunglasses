import React from 'react'
import { describe, expect, it, vi } from 'vitest'

global.React = React

import TopLevelAdminAction from '../app/components/TopLevelAdminAction.jsx'

describe('TopLevelAdminAction', () => {
  // Brief's Step 2 assertion, verbatim: the whole point of this component is
  // that clicking it breaks out of the embedded iframe via window.open, not
  // via href/target (which App Bridge can intercept on an s-* component).
  it('opens Shopify admin outside the embedded iframe', () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open })
    const element = TopLevelAdminAction({
      href: 'https://admin.shopify.com/theme',
      children: 'Open theme editor',
      accessibilityLabel: 'Open theme editor in Shopify admin',
    })
    element.props.onClick()
    expect(open).toHaveBeenCalledWith('https://admin.shopify.com/theme', '_top')
    vi.unstubAllGlobals()
  })

  it('never renders href/target so a native click cannot navigate inside the iframe', () => {
    const element = TopLevelAdminAction({
      href: 'https://admin.shopify.com/pricing',
      children: 'Upgrade plan',
      accessibilityLabel: 'Upgrade plan',
    })

    expect(element.props.href).toBeUndefined()
    expect(element.props.target).toBeUndefined()
  })

  it('marks itself as an external destination with a required accessibility label', () => {
    const element = TopLevelAdminAction({
      href: 'https://admin.shopify.com/theme',
      children: 'Open theme editor',
      accessibilityLabel: 'Open theme editor in Shopify admin',
    })

    expect(element.type).toBe('s-button')
    expect(element.props.icon).toBe('external')
    expect(element.props.accessibilityLabel).toBe('Open theme editor in Shopify admin')
    expect(element.props.children).toBe('Open theme editor')
  })

  it('defaults to a secondary variant but accepts an override', () => {
    const defaulted = TopLevelAdminAction({
      href: 'https://admin.shopify.com/theme',
      children: 'Open theme editor',
      accessibilityLabel: 'Open theme editor',
    })
    const overridden = TopLevelAdminAction({
      href: 'https://admin.shopify.com/theme',
      children: 'Open theme editor',
      accessibilityLabel: 'Open theme editor',
      variant: 'tertiary',
    })

    expect(defaulted.props.variant).toBe('secondary')
    expect(overridden.props.variant).toBe('tertiary')
  })

  // Not part of the brief's documented signature, but required for reuse as
  // a page `slot="primary-action"` control (app._index.jsx, app.products.jsx)
  // -- see the component's own comment for why this can't be a wrapper
  // element instead.
  it('forwards an optional slot for page primary-action placement', () => {
    const element = TopLevelAdminAction({
      href: 'https://admin.shopify.com/pricing',
      children: 'Upgrade plan',
      accessibilityLabel: 'Upgrade plan',
      slot: 'primary-action',
    })

    expect(element.props.slot).toBe('primary-action')
  })

  // Minor-10: every current call site already gates its own href (e.g.
  // `usage.pricingUrl && (<TopLevelAdminAction href={usage.pricingUrl} ...>`),
  // but the component itself had no guard -- unlike the old `openPricing`
  // closure it replaced in app._index.jsx, which had an explicit
  // `if (usage.pricingUrl)` before calling window.open. Without this,
  // window.open(undefined, '_top') would navigate the whole top-level frame
  // to "about:blank" if any future caller forgot that upstream check.
  it('renders nothing and never calls window.open for a falsy href', () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open })

    expect(TopLevelAdminAction({ href: null, children: 'Upgrade plan', accessibilityLabel: 'Upgrade plan' })).toBeNull()
    expect(TopLevelAdminAction({ href: undefined, children: 'Upgrade plan', accessibilityLabel: 'Upgrade plan' })).toBeNull()
    expect(TopLevelAdminAction({ href: '', children: 'Upgrade plan', accessibilityLabel: 'Upgrade plan' })).toBeNull()
    expect(open).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })
})
