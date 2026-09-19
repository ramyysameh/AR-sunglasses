import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

global.React = React

import ModelFitReview from '../app/components/ModelFitReview.jsx'
import ModelViewer from '../app/components/ModelViewer.jsx'

// Same tree-walk helper as appProducts.ui.test.js/productIndex.ui.test.js.
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

// Minor-3: this shared remediation surface (mounted by both Task 6
// destinations -- PreviewPanel and the Models review modal) had zero direct
// test coverage. appModels.ui.test.js only asserts the surrounding modal
// plumbing (id="review-model-fit" once, commandFor twice), never what's
// actually inside the modal. Cover the real conditional at
// ModelFitReview.jsx:37 (themeUrl && ...) and the fit-preview src a
// merchant's reference-head render depends on.
describe('ModelFitReview', () => {
  it('points the reference-head preview at this asset\'s fit-preview GLB', () => {
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
    expect(viewer.props.src).toBe('/models/asset-123/fit-preview.glb?v=2')
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
