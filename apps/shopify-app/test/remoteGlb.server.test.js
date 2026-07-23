import { describe, it, expect, vi, afterEach } from 'vitest'
import { assertAllowedGlbUrl, fetchRemoteGlb } from '../app/remoteGlb.server.js'

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

// Builds a Response whose body is a stream we control, and reports whether the
// stream was cancelled. Asserting cancellation is the observable proof that an
// oversized body was abandoned mid-flight -- "never buffered" is not directly
// observable, so we assert the thing that is.
function streamingResponse(chunks, { headers = {} } = {}) {
  const state = { cancelled: false }
  let i = 0
  const stream = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++])
        return
      }
      controller.close()
    },
    cancel() {
      state.cancelled = true
    },
  })
  return { response: new Response(stream, { status: 200, headers }), state }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const OK_URL = 'https://cdn.shopify.com/a.glb'

describe('fetchRemoteGlb', () => {
  it('returns the body bytes for an allowed url', async () => {
    const { response } = streamingResponse([new Uint8Array([1, 2]), new Uint8Array([3])])
    vi.stubGlobal('fetch', vi.fn(async () => response))

    const bytes = await fetchRemoteGlb(OK_URL)

    expect(Array.from(bytes)).toEqual([1, 2, 3])
  })

  it('refuses redirects, so no redirect chain can leave the allowlist', async () => {
    // Regression test for the demonstrated bug: the old code called bare
    // fetch(), which follows redirects, so an allowed url redirecting to an
    // internal address was fetched. Asserted by outcome, not by the error's
    // identity: the runtime surfaces a refused redirect as a generic TypeError.
    vi.stubGlobal('fetch', vi.fn(async (_u, init) => {
      expect(init.redirect).toBe('error')
      throw new TypeError('fetch failed')
    }))

    await expect(fetchRemoteGlb(OK_URL)).rejects.toMatchObject({ code: 'FETCH_FAILED' })
  })

  it('tags a timeout FETCH_FAILED rather than letting it bubble uncoded', async () => {
    // An uncoded error becomes a 500 at the route instead of the intended 422.
    //
    // The body is a slow drip that stays well under the cap and never ends, so
    // only the timeout can end this. The stub errors the STREAM when the signal
    // fires, which is what a real aborted fetch does -- an earlier version
    // called response.body.cancel() from an abort listener, but the
    // implementation has already locked the body via getReader(), so cancel()
    // threw, was swallowed, and the test hung until the runner killed it.
    // Captured and asserted AFTER the call, deliberately. An assertion placed
    // inside the stub is useless here: it throws, the implementation's own
    // catch tags it FETCH_FAILED, and the outer expectation passes anyway --
    // the code under test swallows the failure. Verified that mistake first.
    let seenSignal
    vi.stubGlobal('fetch', vi.fn(async (_u, init) => {
      seenSignal = init?.signal
      const stream = new ReadableStream({
        async pull(controller) {
          await new Promise((r) => setTimeout(r, 20))
          if (seenSignal?.aborted) {
            controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            return
          }
          controller.enqueue(new Uint8Array(1))
        },
      })
      return new Response(stream, { status: 200 })
    }))

    await expect(
      fetchRemoteGlb(OK_URL, { timeoutMs: 120, maxBytes: 1024 * 1024 }),
    ).rejects.toMatchObject({ code: 'FETCH_FAILED' })

    // These are what make the test about a TIMEOUT rather than about any
    // stream error. Mutation-verified: deleting the signal fails them.
    expect(seenSignal).toBeInstanceOf(AbortSignal)
    expect(seenSignal.aborted).toBe(true)
  })

  it('tags a bodyless response instead of letting a TypeError escape untagged', async () => {
    // getReader() on a null body throws a bare TypeError with no `code`, which
    // the route maps to 500 rather than the intended 422.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))

    await expect(fetchRemoteGlb(OK_URL)).rejects.toMatchObject({ code: 'FETCH_FAILED' })
  })

  it('rejects a non-OK upstream status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    await expect(fetchRemoteGlb(OK_URL)).rejects.toMatchObject({ code: 'FETCH_FAILED' })
  })

  it('rejects on an over-cap content-length without reading the body', async () => {
    const { response } = streamingResponse([new Uint8Array(10)], {
      headers: { 'content-length': '999999' },
    })
    vi.stubGlobal('fetch', vi.fn(async () => response))

    await expect(fetchRemoteGlb(OK_URL, { maxBytes: 100 })).rejects.toMatchObject({
      code: 'TOO_LARGE',
    })
  })

  it('aborts a body that streams past the cap and cancels the stream', async () => {
    const { response, state } = streamingResponse([
      new Uint8Array(60), new Uint8Array(60), new Uint8Array(60),
    ])
    vi.stubGlobal('fetch', vi.fn(async () => response))

    await expect(fetchRemoteGlb(OK_URL, { maxBytes: 100 })).rejects.toMatchObject({
      code: 'TOO_LARGE',
    })
    expect(state.cancelled).toBe(true)
  })

  it('enforces the cap even when content-length under-reports the real size', async () => {
    // Not hypothetical. The real CDN serves these files `content-encoding: br`,
    // so content-length is the COMPRESSED size (2768571 for gripzpelmo.glb)
    // while the decoded body is more than twice that (6064932). Any header-based
    // cap is therefore measuring the wrong quantity, and a hostile server could
    // declare a tiny length whose body decompresses to gigabytes.
    //
    // Three chunks, not two: the cap trips on the second, and a stream whose
    // last chunk has already been enqueued may have closed before cancel() is
    // called -- cancelling a closed stream is a no-op and `cancelled` would
    // stay false for reasons unrelated to the behaviour under test.
    const { response, state } = streamingResponse(
      [new Uint8Array(60), new Uint8Array(60), new Uint8Array(60)],
      { headers: { 'content-length': '10' } },
    )
    vi.stubGlobal('fetch', vi.fn(async () => response))

    await expect(fetchRemoteGlb(OK_URL, { maxBytes: 100 })).rejects.toMatchObject({
      code: 'TOO_LARGE',
    })
    expect(state.cancelled).toBe(true)
  })

  it('rejects a disallowed url before making any request', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)

    await expect(fetchRemoteGlb('https://evil.com/a.glb')).rejects.toMatchObject({
      code: 'URL_NOT_ALLOWED',
    })
    expect(spy).not.toHaveBeenCalled()
  })
})
