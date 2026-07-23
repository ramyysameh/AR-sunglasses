import { tagged } from './errors.server.js'

// Merchants upload GLBs under Settings -> Files, which always serves from this
// host. Pinning to one host makes SSRF unreachable by construction: no redirect
// chain can arrive at an internal address if nothing but this host is fetchable.
const ALLOWED_HOST = 'cdn.shopify.com'

// 25 MB clears the largest real asset in this repo (12.2 MB, an unoptimised
// export) with headroom. The cap bounds the DOWNLOAD; calibrateUpload then
// parses and re-exports, so peak memory is a multiple of this -- the number is
// chosen to stay clear of Vercel's 1 GB function limit, not merely to be
// generous.
const MAX_GLB_BYTES = 25 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000

/**
 * Validates a caller-supplied model URL and RETURNS THE PARSED URL.
 *
 * Returning the parsed object matters: the caller fetches this object rather
 * than re-parsing the string, so there is no second parse that could disagree
 * with the one that was validated.
 *
 * @throws an error tagged URL_NOT_ALLOWED
 */
export function assertAllowedGlbUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw tagged('URL_NOT_ALLOWED', `unparseable model url: ${String(url)}`)
  }

  // Exact equality, never a substring check. Verified that the two lookalike
  // shapes defeat DIFFERENT naive checks, which is why neither endsWith nor
  // startsWith alone is sufficient:
  //   'evil-cdn.shopify.com'.endsWith('cdn.shopify.com')           === true
  //   'cdn.shopify.com.attacker.net'.startsWith('cdn.shopify.com') === true
  //
  // .toLowerCase() is belt-and-braces: the WHATWG parser already lowercases the
  // host for special schemes like https, so it is redundant given the protocol
  // check below. Kept because it costs nothing and makes the comparison
  // self-evidently case-safe rather than relying on a parser guarantee stated
  // three lines away. Deliberately NOT covered by a test -- a case-variant test
  // would pass with or without it, and a test that cannot fail is noise.
  const hostOk = parsed.hostname.toLowerCase() === ALLOWED_HOST
  // Credentials are rejected because https://cdn.shopify.com@evil.com/ parses
  // with hostname evil.com while reading as allowlisted to a human.
  const noCredentials = parsed.username === '' && parsed.password === ''

  if (parsed.protocol !== 'https:' || !hostOk || parsed.port !== '' || !noCredentials) {
    throw tagged('URL_NOT_ALLOWED', `model url not allowed: ${parsed.protocol}//${parsed.host}`)
  }

  return parsed
}

/**
 * Fetches a GLB from an allowlisted host under strict size and time bounds.
 *
 * `redirect: 'error'` is load-bearing. The previous implementation called bare
 * fetch(), which defaults to following redirects and does NOT re-apply the
 * caller's protocol check to the redirect target -- so an attacker-controlled
 * https url redirecting to an internal address was fetched by the server. With
 * a single-host allowlist, any redirect leaves the allowlist by definition, so
 * refusing outright is both safest and simplest. Verified that Shopify's CDN
 * returns a direct 200, so this costs nothing.
 *
 * `opts` exists only so tests can run fast; production always uses the defaults
 * and callers pass nothing.
 *
 * @returns {Promise<Uint8Array>}
 */
export async function fetchRemoteGlb(url, { timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_GLB_BYTES } = {}) {
  const parsed = assertAllowedGlbUrl(url)

  let response
  try {
    response = await fetch(parsed, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    // Everything fetch rejects with must be caught and tagged, or it bubbles
    // uncoded and becomes a 500 instead of the intended 422. This covers the
    // refused redirect (TypeError), the timeout (AbortError) and network
    // failure (TypeError) alike -- all three are 422, so discriminating them
    // would add version-fragile branching for no behavioural difference.
    throw tagged('FETCH_FAILED', `fetch failed: ${error?.name ?? 'unknown'}`)
  }

  if (!response.ok) {
    throw tagged('FETCH_FAILED', `upstream returned ${response.status}`)
  }

  // Fast path only. Never the enforcement mechanism: the header can be absent
  // or simply lie, and trusting it is how size caps get bypassed.
  //
  // It is also measuring a DIFFERENT QUANTITY than the loop below. Verified
  // against the real CDN: gripzpelmo.glb is served `content-encoding: br` with
  // `content-length: 2768571`, and decodes to 6064932 bytes. fetch decompresses
  // transparently, so `declared` is the COMPRESSED size while the loop counts
  // DECODED bytes. That gap is precisely why the loop has to exist -- a hostile
  // server could declare a tiny length whose body decompresses to gigabytes,
  // and only a decoded-byte count catches it.
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Swallow a failing cancel: we are already throwing TOO_LARGE, and letting
    // a cancel rejection replace it would escape UNTAGGED and become a 500.
    try {
      await response.body?.cancel()
    } catch {
      // nothing to salvage -- the caller gets TOO_LARGE either way
    }
    throw tagged('TOO_LARGE', `declared size ${declared} exceeds ${maxBytes}`)
  }

  // A bodyless response would make getReader() throw a bare TypeError, which
  // escapes with no `code` and is mapped to 500 instead of the intended 422.
  // Verified: `new Response(null, { status: 200 })` reaches exactly that path.
  if (!response.body) {
    throw tagged('FETCH_FAILED', 'upstream returned no body')
  }

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw tagged('TOO_LARGE', `body exceeded ${maxBytes}`)
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error?.code === 'TOO_LARGE') throw error
    // A timeout during streaming lands here, not in the fetch catch above.
    throw tagged('FETCH_FAILED', `stream failed: ${error?.name ?? 'unknown'}`)
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
