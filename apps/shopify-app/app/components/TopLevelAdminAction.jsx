/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */

// Every destination in Shopify admin (theme editor, Managed Pricing) is not
// embeddable inside this app's iframe. An <s-button href target="_top"> is
// not reliable for that break-out -- App Bridge intercepts navigation from
// Polaris s-* components (see app.jsx's no-plan fallback, which uses a raw
// <a> for exactly this reason) -- so this performs the top-level navigation
// itself, imperatively, from a click handler App Bridge has no say over.
//
// `onClick` (not `href`/`target`) is deliberate: React 18 dispatches the
// simple `click` event to any element regardless of tag name, so this works
// the same way this app's other onClick-driven s-button controls already do.
//
// `slot` is intentionally accepted and forwarded even though it is not part
// of this component's documented interface: a page's `primary-action` slot
// (app._index.jsx, app.products.jsx) requires the `slot` attribute on the
// actual rendered element, and there is no wrapper here to carry it instead
// -- forwarding it is the only way this component can also serve as a page
// primary action without duplicating its onClick/icon/accessibilityLabel
// logic at each call site.
export default function TopLevelAdminAction({
  href,
  children,
  accessibilityLabel,
  variant = 'secondary',
  slot,
}) {
  // Every current call site always has a truthy href by the time it renders
  // this (each is already gated by its own `usage.pricingUrl && (...)` /
  // `themeUrl && (...)` check upstream), but nothing enforces that here --
  // and window.open(undefined, '_top') would navigate the whole top-level
  // frame to "about:blank". The pre-TopLevelAdminAction version of the
  // Upgrade-plan button (app._index.jsx's old `openPricing` closure) had an
  // explicit `if (usage.pricingUrl)` guard; this restores that guarantee
  // inside the shared component itself instead of trusting every future
  // caller to repeat it.
  if (!href) return null
  return (
    <s-button
      slot={slot}
      variant={variant}
      icon="external"
      accessibilityLabel={accessibilityLabel}
      onClick={() => window.open(href, '_top')}
    >
      {children}
    </s-button>
  )
}
