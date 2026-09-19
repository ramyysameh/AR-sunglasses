import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import Index, { loader, meta } from '../app/routes/_index/route.jsx'

global.React = React

function render() {
  return renderToStaticMarkup(React.createElement(Index))
}

describe('public landing loader', () => {
  it('sends a merchant arriving with ?shop into the embedded app, preserving params', async () => {
    // A merchant opening the app from the admin always carries ?shop (plus
    // host/embedded/id_token). They must never see the marketing page.
    const request = new Request('https://example.com/?shop=demo.myshopify.com&host=abc&embedded=1')
    const redirect = await loader({ request }).catch((thrown) => thrown)

    expect(redirect.status).toBe(302)
    const location = redirect.headers.get('location')
    expect(location.startsWith('/app?')).toBe(true)
    expect(location).toContain('shop=demo.myshopify.com')
    expect(location).toContain('host=abc')
  })

  it('renders the marketing page when there is no shop param', async () => {
    const request = new Request('https://example.com/')
    await expect(loader({ request })).resolves.toBeNull()
  })
})

describe('public landing page', () => {
  it('leads with the product, not an install instruction', () => {
    const html = render()
    expect(html).toContain('Try sunglasses on, right on the product page')
    expect(html).toContain('Get it on the Shopify App Store')
    expect(html).toContain('href="https://apps.shopify.com"')
  })

  it('states the three selling points a merchant is deciding on', () => {
    const html = render()
    expect(html).toContain('Live camera try-on')
    expect(html).toContain('Nothing is stored')
    expect(html).toContain('Set up in minutes')
  })

  it('offers privacy and support routes', () => {
    const html = render()
    expect(html).toContain('href="/privacy"')
    expect(html).toContain('href="mailto:zendolabs@gmail.com"')
  })

  it('opens the external App Store link safely', () => {
    const html = render()
    expect(html).toMatch(/href="https:\/\/apps\.shopify\.com"[^>]*target="_blank"[^>]*rel="noreferrer"/)
  })

  it('describes itself for search and link previews', () => {
    const tags = meta()
    expect(tags.find((tag) => tag.title)).toBeTruthy()
    const description = tags.find((tag) => tag.name === 'description')
    expect(description.content).toContain('camera')
  })
})
