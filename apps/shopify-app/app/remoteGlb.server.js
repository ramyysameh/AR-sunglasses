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

  // Exact equality, NOT endsWith: endsWith('cdn.shopify.com') would accept both
  // evil-cdn.shopify.com and cdn.shopify.com.attacker.net.
  const hostOk = parsed.hostname.toLowerCase() === ALLOWED_HOST
  // Credentials are rejected because https://cdn.shopify.com@evil.com/ parses
  // with hostname evil.com while reading as allowlisted to a human.
  const noCredentials = parsed.username === '' && parsed.password === ''

  if (parsed.protocol !== 'https:' || !hostOk || parsed.port !== '' || !noCredentials) {
    throw tagged('URL_NOT_ALLOWED', `model url not allowed: ${parsed.protocol}//${parsed.host}`)
  }

  return parsed
}
