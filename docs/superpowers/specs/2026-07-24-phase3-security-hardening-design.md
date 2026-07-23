# Phase 3 — Security hardening: design

**Date:** 2026-07-24
**Milestone:** Shopify App Store submission (roadmap: `2026-07-17-app-store-submission-roadmap.md`)
**Status:** design approved, pending implementation plan

## Goal

Close the verified SSRF in the public `register-model` endpoint and bound its
resource consumption, so the app can be submitted without a known-exploitable
server-side request forgery.

Exit criteria:

- `register-model` fetches only from `cdn.shopify.com`, over https, and refuses
  redirects.
- A response body exceeding the size cap is aborted mid-stream, not buffered.
- Registration is rejected for shops with no installed session.
- Per-shop model count is bounded.
- No internal error text reaches a client.
- `Access-Control-Allow-Origin: *` removed from all three public endpoints.

## Context

Phase 2 shipped a data-integrity guard on `registerModelByUrl`'s `shop`
parameter and explicitly deferred authentication here. Reading the endpoint for
this phase surfaced that its SSRF protection is not weak but **absent**.

### The vulnerability, verified

`app/routes/api.register-model.jsx` validates `^https://` on the caller-supplied
URL, then `app/models.server.js` calls `fetch(url)`. Node's `fetch` defaults to
`redirect: 'follow'` and does **not** re-apply the caller's protocol check to
redirect targets.

Demonstrated on Node v24.13.0 during design:

```
followed redirect -> http://neverssl.com/
final protocol    : http:
SSRF BYPASS CONFIRMED: https check evaded via redirect
```

So `https://attacker.com/x.glb` returning a 302 to `http://169.254.169.254/...`
is fetched by the server. The `^https://` check constrains only the first hop.

### Other findings

| # | Issue | Severity |
|---|---|---|
| 1 | SSRF via redirect (above) | High |
| 2 | `response.arrayBuffer()` buffers an unbounded body — OOM | High |
| 3 | `shop` is caller-supplied; models attributable to any store | Medium |
| 4 | No quota — each distinct URL creates an S3 object + row | Medium |
| 5 | `ACAO: *` on all three public endpoints, though the engine is same-origin | Medium |
| 6 | `err.message` returned to the client — leaks internals | Medium |

### Measurements taken during design

- `https://cdn.shopify.com/s/files/1/0868/5862/9313/files/gripzpelmo.glb?v=...`
  returns **200 with no redirect**, `content-type: model/gltf-binary`,
  2,768,571 bytes. `redirect: 'error'` therefore costs nothing.
- Real GLBs in this repo range 1.2 MB → 12.2 MB (largest is an unoptimized
  export).

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Allowlist is exactly `cdn.shopify.com` | Merchants upload GLBs under Settings → Files, which always serves from that host. One host makes SSRF unreachable by construction |
| D2 | `redirect: 'error'` | With a single-host allowlist, any redirect leaves the allowlist by definition. Verified the CDN never redirects |
| D3 | Hostname compared by **exact equality** | `endsWith` accepts `evil-cdn.shopify.com` and `cdn.shopify.com.attacker.net` |
| D4 | Size enforced **while streaming**, not from `Content-Length` | The header can be absent or lie; trusting it is how caps get bypassed |
| D5 | Installed-shop check, not real authentication | A storefront shopper has no admin session; App Proxy would restructure how the block, engine and app communicate. Deferred — see Non-goals |
| D6 | Per-shop quota, not a sliding-window rate limiter | Bounds storage growth with one COUNT and no new table; dedupe-by-URL already prevents repeat calibration |
| D7 | CORS removed from all three public endpoints | The engine is served from the app and calls `/api/*` relatively — same-origin. The headers are vestigial |

## Architecture

```
app/
  remoteGlb.server.js          NEW  assertAllowedGlbUrl + fetchRemoteGlb
  models.server.js             MOD  use fetchRemoteGlb; installed-shop; quota
  routes/
    api.register-model.jsx     MOD  generic errors; drop CORS
    api.tryon-config.jsx       MOD  drop CORS
    models.$assetId[.]glb.jsx  MOD  drop CORS
```

`remoteGlb.server.js` is separate from `models.server.js` so URL validation is
testable with no network and no database, and so the security-critical logic sits
in one small file rather than inside a function that also calibrates and
persists.

### Constants

```js
const ALLOWED_HOST = 'cdn.shopify.com'
const MAX_GLB_BYTES = 25 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000
const MAX_MODELS_PER_SHOP = 50
```

25 MB clears the largest real asset (12.2 MB) with headroom. The cap bounds the
*download*; `calibrateUpload` then parses and re-exports, so peak memory is a
multiple of it — 25 MB is chosen to stay clear of Vercel's 1 GB function limit,
not merely to be generous.

### `assertAllowedGlbUrl(url)`

Throws unless **all** hold:

- parses as a URL
- `protocol === 'https:'`
- `hostname === ALLOWED_HOST` (exact equality, case-insensitive)
- `port` is empty
- no embedded credentials (`username`/`password` empty)

Credentials are rejected because `https://cdn.shopify.com@evil.com/` parses with
hostname `evil.com` — a parser-confusion vector that reads as allowlisted.

### `fetchRemoteGlb(url)`

1. `assertAllowedGlbUrl(url)`.
2. `fetch(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })`.
3. Non-OK → throw.
4. `Content-Length` present and over cap → reject immediately (fast path only).
5. Read the body stream, accumulating chunks; if the running total exceeds
   `MAX_GLB_BYTES`, cancel the stream and throw.
6. Return `Uint8Array`.

### `registerModelByUrl` changes

Order matters — cheapest and most restrictive checks first, so an attacker
cannot induce work before being rejected:

1. existing `shop` shape guard (unchanged)
2. **installed-shop check** — `session.findFirst({ where: { shop } })`, else throw
3. `assertAllowedGlbUrl(url)` — before any DB or network work
4. dedupe lookup (unchanged)
5. **quota check** — `modelAsset.count({ where: { shop } })` ≥ `MAX_MODELS_PER_SHOP` → throw
6. `fetchRemoteGlb(url)` replaces the bare `fetch`
7. calibrate → store → persist (unchanged)

The quota is checked after dedupe so a merchant at the limit can still resolve
models they already registered.

**Consequence of ordering `assertAllowedGlbUrl` before dedupe:** any existing
`ModelAsset` whose `sourceUrl` is not on `cdn.shopify.com` becomes unresolvable —
the assert throws before the dedupe lookup runs. This is intentional (a
non-allowlisted URL should not be honoured just because it was registered before
the rule existed) and currently affects **nothing**: the live database holds zero
`ModelAsset` rows, verified 2026-07-24. Worth re-checking if this phase is
implemented after real merchant data exists.

### What the installed-shop check does NOT do

It proves the named shop is an installed customer. It does **not** prove the
caller is that shop — shop A's storefront can still register a GLB under shop
B's name. With D1 in force the residual abuse is narrow (attributing a
Shopify-hosted GLB to another installed store, bounded by D6), but it is not
zero. The code comment must say this plainly rather than implying the endpoint
is authenticated.

### Error handling

**How the route classifies errors.** Today it regex-matches `err.message`, which
cannot survive generic client messages — and matching on prose is fragile
anyway. Every error thrown by `remoteGlb.server.js` and `registerModelByUrl`
carries a machine-readable `code` property:

```js
Object.assign(new Error('url host not allowed'), { code: 'URL_NOT_ALLOWED' })
```

Codes: `URL_NOT_ALLOWED`, `SHOP_NOT_INSTALLED`, `QUOTA_EXCEEDED`,
`FETCH_FAILED`, `TOO_LARGE`, `REDIRECTED`. The route maps code → status and
never forwards `err.message`. An unrecognised code falls through to 500, so a
new throw site fails closed rather than leaking its message.

The route logs the real error server-side and returns a fixed message per class:

| Condition | Status | Body |
|---|---|---|
| missing/malformed `url` or `shop` | 400 | `invalid request` |
| URL not allowlisted | 400 | `model url must be hosted on cdn.shopify.com` |
| shop not installed | 403 | `shop not found` |
| quota exceeded | 429 | `model limit reached` |
| upstream fetch failed / too large / redirected | 422 | `could not retrieve model` |
| anything else | 500 | `registration failed` |

The allowlist message is deliberately specific: it is actionable for a merchant
and reveals nothing an attacker cannot read in this spec.

## CORS removal

`ACAO: *` is deleted from `api.register-model.jsx`, `api.tryon-config.jsx`, and
`models.$assetId[.]glb.jsx`. The engine is served at `<app>/tryon/index.html` and
issues relative requests, so all three are same-origin in the supported
configuration. Serving the engine from another origin is unsupported and already
broken (relative paths would resolve to the wrong host).

`Cache-Control` on the GLB route is retained.

## Testing

Unit tests, no network, no database, for `remoteGlb.server.js`:

1. Accepts the real Shopify CDN URL shape.
2. Rejects `http://`.
3. Rejects a different host.
4. **Rejects `evil-cdn.shopify.com` and `cdn.shopify.com.attacker.net`** — the
   two bypasses an `endsWith` implementation would allow.
5. Rejects `https://cdn.shopify.com@evil.com/x.glb` (credential confusion).
6. Rejects a non-empty port.
7. **Rejects a redirect response** — the regression test for the demonstrated
   bug. This is the single most important test in the phase.
8. Aborts a body that streams past the cap, asserting the whole body was never
   buffered.
9. Rejects on an over-cap `Content-Length` fast path.
10. Rejects a body that under-reports `Content-Length` but streams over the cap —
    proving enforcement does not rely on the header.

Integration tests against Neon, using the established `randomUUID()`-tagged
fixture discipline (**mandatory** — dev and production share one database):

11. Registration rejected for a shop with no session.
12. Quota boundary: at `MAX_MODELS_PER_SHOP - 1` succeeds, at the limit rejects.
13. Dedupe still resolves for a shop already at quota.

Route tests: each error class returns the right status, and the response body
contains no internal error text.

## Out of scope

- **Shopify App Proxy / true request authentication.** Would restructure how the
  theme block, engine and app communicate. Revisit if abuse is observed.
- Rate limiting by request frequency (D6 chose a quota).
- Authenticating `api.tryon-config` or the GLB route — both serve
  merchant-public product data behind unguessable UUIDs.
- The pre-existing project-wide ESLint failures (918 at Phase 2's branch base).
