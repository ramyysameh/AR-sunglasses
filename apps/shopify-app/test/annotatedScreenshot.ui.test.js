import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import AnnotatedScreenshot from '../app/components/AnnotatedScreenshot.jsx'
import { TUTORIAL_STEPS } from '../app/tutorialSteps.js'

global.React = React

const marks = [
  { n: 1, kind: 'circle', x: 20, y: 30, w: 10, h: 6, caption: 'Choose products' },
  { n: 2, kind: 'arrow', x: 60, y: 70, toX: 45, toY: 55, caption: 'Tick 3 or 4 photos' },
  { n: 3, kind: 'box', x: 10, y: 80, w: 30, h: 8, caption: 'Generate' },
]

describe('AnnotatedScreenshot', () => {
  const html = renderToStaticMarkup(React.createElement(AnnotatedScreenshot, {
    src: '/tutorial/create.png', alt: 'Create with AI', width: 1280, height: 800, marks,
  }))

  it('draws the screenshot with an SVG overlay in percentage space', () => {
    expect(html).toContain('src="/tutorial/create.png"')
    expect(html).toContain('viewBox="0 0 100 100"')
    expect(html).toContain('preserveAspectRatio="none"')
  })

  it('draws circles, arrows and boxes with numbered markers', () => {
    expect(html).toContain('<ellipse')
    expect(html).toContain('marker-end')
    expect(html).toContain('<rect')
    for (const n of ['1', '2', '3']) expect(html).toContain(`>${n}</`)
  })

  it('lists a caption per marker number', () => {
    expect(html).toContain('Choose products')
    expect(html).toContain('Tick 3 or 4 photos')
  })

  it('hides the decorative overlay from assistive tech and lists captions in order', () => {
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('alt="Create with AI"')
    expect(html).toMatch(/<figcaption><ol[^>]*><li value="1">/)
  })
})

describe('TUTORIAL_STEPS', () => {
  it('covers the four steps in order with marks inside the image', () => {
    expect(TUTORIAL_STEPS.map((s) => s.id)).toEqual(['create', 'save', 'turn-on', 'check'])
    for (const step of TUTORIAL_STEPS) {
      expect(step.image.src).toMatch(/^\/tutorial\/.+\.png$/)
      for (const m of step.marks) {
        expect(m.x).toBeGreaterThanOrEqual(0)
        expect(m.x).toBeLessThanOrEqual(100)
        expect(m.y).toBeGreaterThanOrEqual(0)
        expect(m.y).toBeLessThanOrEqual(100)
        expect(m.caption).toBeTruthy()
      }
    }
  })
})
