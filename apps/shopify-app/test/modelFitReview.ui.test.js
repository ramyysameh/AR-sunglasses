import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

global.React = React

import ModelFitReview from '../app/components/ModelFitReview.jsx'
import ModelViewer from '../app/components/ModelViewer.jsx'

// Same tree-walk helper as appProducts.ui.test.js.
function findElement(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  const children = node.props?.children
  if (children === undefined) return null
  const list = Array.isArray(children) ? children : [children]
  for (const child of list) {
    const found = findElement(child, predicate)
    if (found) return found
  }
  return null
}

// This remediation surface (mounted by the Models review modal) had zero
// direct test coverage. appModels.ui.test.js only asserts the surrounding
// modal plumbing (id="review-model-fit" once, commandFor twice), never what's
// actually inside the modal. Cover the real themeUrl conditional and the
// preview src the merchant's render depends on.
describe('ModelFitReview', () => {
  it('points the preview at this asset\'s own GLB, not the reference-head composition', () => {
    // Called directly (no hooks of its own), the same way
    // topLevelAdminAction.ui.test.js exercises TopLevelAdminAction -- this
    // returns the real element tree with ModelViewer still unexpanded, so
    // its `src` prop is inspectable without jsdom. renderToStaticMarkup
    // can't be used for this particular assertion: ModelViewer only ever
    // reaches its "Loading 3D preview" spinner branch during SSR (the real
    // <model-viewer src=...> only mounts client-side, after an
    // IntersectionObserver + dynamic import that never resolve server-side),
    // so the src attribute never reaches rendered HTML.
    const element = ModelFitReview({ modelAssetId: 'asset-123', themeUrl: null })
    const viewer = findElement(element, (node) => node.type === ModelViewer)

    expect(viewer).not.toBeNull()
    // Upstream decided in 9d93e54 that the admin previews the model on its
    // own, not composed onto a mock head ("previews the glasses model without
    // composing it onto a mock head" in appProducts.ui.test.js). This surface
    // follows that decision so the two admin previews cannot disagree.
    expect(viewer.props.src).toBe('/models/asset-123.glb')
    expect(viewer.props.alt).toBe('Your glasses model')
    expect(viewer.props.src).not.toContain('fit-preview')
  })

  it('shows the Glasses size sizing guidance and omits the theme action when no theme URL is available', () => {
    const html = renderToStaticMarkup(
      React.createElement(ModelFitReview, { modelAssetId: 'asset-123', themeUrl: null }),
    )

    expect(html).toContain('Glasses size')
    expect(html).not.toContain('Open theme editor')
  })

  it('offers a direct theme-editor action when a theme URL is available', () => {
    const html = renderToStaticMarkup(
      React.createElement(ModelFitReview, { modelAssetId: 'asset-123', themeUrl: 'https://admin.shopify.com/theme' }),
    )

    expect(html).toContain('Open theme editor')
    expect(html).toContain('accessibilityLabel="Open the theme editor to adjust glasses size"')
  })
})
