import { describe, it, expect } from 'vitest'
import { assertAllowedGlbUrl } from '../app/remoteGlb.server.js'

const OK = 'https://cdn.shopify.com/s/files/1/0868/5862/9313/files/gripzpelmo.glb?v=1783771184'

describe('assertAllowedGlbUrl', () => {
  it('accepts a real Shopify CDN url and returns the parsed URL', () => {
    const parsed = assertAllowedGlbUrl(OK)
    // Returning the parsed object is the contract: Task 2 fetches THIS, so there
    // is no second parse that could disagree with the one that was validated.
    expect(parsed).toBeInstanceOf(URL)
    expect(parsed.href).toBe(OK)
  })

  it.each([
    ['plain http', 'http://cdn.shopify.com/a.glb'],
    ['a different host', 'https://example.com/a.glb'],
    // Named explicitly: this is the concrete target the design demonstrated
    // reaching through a redirect. Generic "different host" coverage does not
    // make the threat legible to a future reader.
    ['the cloud metadata endpoint', 'https://169.254.169.254/latest/meta-data/'],
    // Both of these pass a naive endsWith('cdn.shopify.com') check.
    ['a lookalike prefix host', 'https://evil-cdn.shopify.com/a.glb'],
    ['a lookalike suffix host', 'https://cdn.shopify.com.attacker.net/a.glb'],
    // Parses with hostname evil.com but reads as allowlisted to a human.
    ['embedded credentials', 'https://cdn.shopify.com@evil.com/a.glb'],
    ['a non-default port', 'https://cdn.shopify.com:8443/a.glb'],
    ['a garbage string', 'not a url at all'],
    ['an empty string', ''],
  ])('rejects %s', (_label, bad) => {
    expect(() => assertAllowedGlbUrl(bad)).toThrow()
    try {
      assertAllowedGlbUrl(bad)
    } catch (e) {
      expect(e.code).toBe('URL_NOT_ALLOWED')
    }
  })

  it('is case-insensitive on the host', () => {
    expect(assertAllowedGlbUrl('https://CDN.Shopify.COM/a.glb')).toBeInstanceOf(URL)
  })
})
