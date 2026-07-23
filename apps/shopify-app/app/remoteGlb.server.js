import { tagged } from './errors.server.js'

// Merchants upload GLBs under Settings -> Files, which always serves from this
// host. Pinning to one host makes SSRF unreachable by construction: no redirect
// chain can arrive at an internal address if nothing but this host is fetchable.
const ALLOWED_HOST = 'cdn.shopify.com'

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
