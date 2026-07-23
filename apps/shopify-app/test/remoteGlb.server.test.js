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
    // These defeat DIFFERENT naive checks -- verified, not assumed:
    //   'evil-cdn.shopify.com'.endsWith('cdn.shopify.com')       === true
    //   'cdn.shopify.com.attacker.net'.startsWith('cdn.shopify.com') === true
    // Only exact equality rejects both.
    ['a lookalike host that defeats endsWith', 'https://evil-cdn.shopify.com/a.glb'],
    ['a lookalike host that defeats startsWith', 'https://cdn.shopify.com.attacker.net/a.glb'],
    // Reads as allowlisted to a human, but parses with hostname evil.com, so it
    // is the HOSTNAME check that rejects this one -- not the credentials check.
    // See the dedicated credentials test below for that branch.
    ['a host-confusing credential form', 'https://cdn.shopify.com@evil.com/a.glb'],
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

  it('rejects credentials on the allowed host, isolating the credentials check', () => {
    // The ONLY case that exercises the noCredentials branch. Verified this
    // parses with hostname cdn.shopify.com and username 'user', so the host,
    // protocol and port checks all pass -- delete noCredentials from the
    // implementation and this is the test that fails.
    expect(() => assertAllowedGlbUrl('https://user:pass@cdn.shopify.com/a.glb')).toThrow()
    try {
      assertAllowedGlbUrl('https://user:pass@cdn.shopify.com/a.glb')
    } catch (e) {
      expect(e.code).toBe('URL_NOT_ALLOWED')
    }
  })
})
