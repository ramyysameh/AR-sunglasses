import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SetupSteps from '../app/components/SetupSteps.jsx'

global.React = React

const steps = (states) => ({
  done: states.every((s) => s === 'done'),
  steps: [
    { id: 'create', title: 'Create 3D models', state: states[0] },
    { id: 'save', title: 'Review and save', state: states[1] },
    { id: 'turn-on', title: 'Turn on try-on in your store', state: states[2] },
  ],
})
const render = (states, extra = {}) => renderToStaticMarkup(React.createElement(SetupSteps, {
  setup: steps(states),
  embedUrl: 'https://s.myshopify.com/admin/themes/current/editor?context=apps',
  storefrontUrl: 'https://s.myshopify.com/products/aviator',
  aiEnabled: true,
  onUploadModel: () => {},
  onCheckAgain: () => {},
  ...extra,
}, React.createElement('div', { id: 'create-panel' })))

describe('SetupSteps', () => {
  it('numbers the three steps and marks the current one', () => {
    const html = render(['current', 'upcoming', 'upcoming'])
    expect(html).toContain('Create 3D models')
    expect(html).toContain('Review and save')
    expect(html).toContain('Turn on try-on in your store')
    expect(html).toContain('aria-current="step"')
    // The Create with AI panel lives on the page, not in the steps.
    expect(html).not.toContain('id="create-panel"')
    expect(html).toContain('Use Create with AI below')
    expect(html).toContain('Upload a .glb model')
  })

  it('offers the one-click switch and a storefront link on the last step', () => {
    const html = render(['done', 'done', 'current'])
    expect(html).toContain('Turn on try-on')
    expect(html).toContain('In the theme editor, click Save')
    expect(html).toContain('View on your store')
    expect(html).toContain('href="https://s.myshopify.com/products/aviator" target="_blank" rel="noreferrer"')
    expect(html).toContain('Check again')
  })

  it('renders nothing once setup is done', () => {
    expect(render(['done', 'done', 'done'])).toBe('')
  })

  it('offers uploading a .glb as the primary action when AI is off', () => {
    const html = render(['current', 'upcoming', 'upcoming'], { aiEnabled: false })
    expect(html).toContain('Upload a 3D model of your frame to get started.')
    expect(html).not.toContain('Use Create with AI')
    expect(html).toMatch(/<s-button variant="primary"[^>]*>Upload a \.glb model<\/s-button>/)
  })

  it('offers Add try-on once a model exists and AI is off', () => {
    const html = render(['done', 'current', 'upcoming'], { aiEnabled: false })
    expect(html).toContain('Add try-on to a product with your model.')
    expect(html).toMatch(/<s-button variant="primary"[^>]*>Add try-on<\/s-button>/)
    expect(html).not.toContain('Upload a .glb model')
  })
})
