/**
 * Errors crossing a trust boundary carry a machine-readable `code` so the route
 * can choose a status without matching on message prose, and so no internal
 * message is ever forwarded to a client.
 *
 * An unrecognised code maps to 500 at the route, so a new throw site fails
 * closed rather than leaking whatever it happened to say.
 */
export function tagged(code, message) {
  return Object.assign(new Error(message), { code })
}
