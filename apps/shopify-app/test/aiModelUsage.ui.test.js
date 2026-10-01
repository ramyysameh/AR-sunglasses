import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import AiModelUsage from '../app/components/AiModelUsage.jsx'

global.React = React

const render = (allowance) => renderToStaticMarkup(React.createElement(AiModelUsage, { allowance }))

describe('AiModelUsage', () => {
  it('shows used of allowance with a bar', () => {
    const html = render({ allowance: 10, used: 3, unlimited: false, freeRemaining: 7 })
    expect(html).toContain('3 of 10 free AI models used')
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('width:30%')
  })

  it('says what happens after the free models run out', () => {
    const html = render({ allowance: 10, used: 12, unlimited: false, freeRemaining: 0 })
    expect(html).toContain('10 of 10 free AI models used')
    expect(html).toContain('then $5 each')
    expect(html).toContain('width:100%')
  })

  it('has no bar on an unlimited plan', () => {
    const html = render({ allowance: null, used: 4, unlimited: true, freeRemaining: null })
    expect(html).toContain('Unlimited AI models · 4 created')
    expect(html).not.toContain('progressbar')
  })

  it('renders nothing when the feature is off', () => {
    expect(render(null)).toBe('')
  })
})
