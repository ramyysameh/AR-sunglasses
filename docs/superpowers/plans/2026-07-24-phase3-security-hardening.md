# Phase 3 Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the verified SSRF in the public `register-model` endpoint, bound its resource consumption, and stop leaking internal errors — so the app can be submitted without a known-exploitable server-side request forgery.

**Architecture:** A new `remoteGlb.server.js` owns URL validation and bounded fetching, kept separate from `models.server.js` so the security-critical logic is small and testable with no network or database. Errors carry machine-readable `code` properties; the route maps code → status and never forwards an error message. Fetching is pinned to `cdn.shopify.com` with redirects refused, so no redirect chain can reach an internal address.

**Tech Stack:** React Router v7, `@shopify/shopify-app-react-router`, Prisma 6.19.3 → Neon Postgres, Vitest, Node 24 `fetch`/`ReadableStream`.

**Spec:** `docs/superpowers/specs/2026-07-24-phase3-security-hardening-design.md`

## Global Constraints

- All work in `apps/shopify-app/`. Run all commands from there.
- JavaScript ESM, no TypeScript. **Match the style of the file you are editing** — `app/*.server.js` and hand-written `app/routes/api.*.jsx` use single quotes and no semicolons; the template-generated `webhooks.app.*` routes use double quotes and semicolons. Do not restyle a file you are only partly changing.
- Exact values, copied verbatim:
  - `ALLOWED_HOST = 'cdn.shopify.com'`
  - `MAX_GLB_BYTES = 25 * 1024 * 1024`
  - `FETCH_TIMEOUT_MS = 15_000`
  - `MAX_MODELS_PER_SHOP = 50`
- Error codes, exactly these strings: `URL_NOT_ALLOWED`, `SHOP_INVALID`, `SHOP_NOT_INSTALLED`, `QUOTA_EXCEEDED`, `FETCH_FAILED`, `TOO_LARGE`. **There is deliberately no `REDIRECTED` code** — a refused redirect is tagged `FETCH_FAILED` (see spec).
- Tests: `npm test` (vitest, `fileParallelism: false`, `testTimeout: 30000`, `.env` auto-loaded).
- **The database is shared between dev and production.** Every DB fixture shop domain must be uniquely generated per run (`` `x-${randomUUID()}.myshopify.com` ``) and cleaned up in `afterAll`. A predictable filter in a deleting test is a production incident.
- Never forward `err.message` to a client. Log it server-side instead.
- Commit after every task.

---

### Task 1: `errors.server.js` and URL allowlist

**Files:**
- Create: `app/errors.server.js`
- Create: `app/remoteGlb.server.js`
- Test: `test/remoteGlb.server.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `tagged(code: string, message: string) => Error` — an `Error` with a `code` property. Tasks 2 and 3 use it.
  - `assertAllowedGlbUrl(url: string) => URL` — **returns the parsed URL**; throws a `URL_NOT_ALLOWED`-tagged error otherwise. Task 2 uses the returned object.

- [ ] **Step 1: Write the failing tests**

Create `test/remoteGlb.server.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/remoteGlb.server.test.js`
Expected: FAIL — cannot resolve `../app/remoteGlb.server.js`.

- [ ] **Step 3: Implement `errors.server.js`**

Create `app/errors.server.js`:

```js
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
```

- [ ] **Step 4: Implement `assertAllowedGlbUrl`**

Create `app/remoteGlb.server.js`:

```js
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- test/remoteGlb.server.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 6: Lint the files you changed**

Run: `npx eslint app/errors.server.js app/remoteGlb.server.js test/remoteGlb.server.test.js`
Expected: 0 problems. (The project has many pre-existing lint errors elsewhere; fix only your files.)

- [ ] **Step 7: Commit**

```bash
git add app/errors.server.js app/remoteGlb.server.js test/remoteGlb.server.test.js
git commit -m "feat(security): add tagged errors and GLB url allowlist

Pins fetchable hosts to cdn.shopify.com with exact hostname equality,
rejecting the endsWith bypasses, embedded credentials, non-default ports
and non-https schemes. Returns the parsed URL so the caller need not
re-parse."
```

---

### Task 2: Bounded fetch

**Files:**
- Modify: `app/remoteGlb.server.js`
- Test: `test/remoteGlb.server.test.js`

**Interfaces:**
- Consumes: `assertAllowedGlbUrl`, `tagged` from Task 1.
- Produces: `fetchRemoteGlb(url: string, opts?: { timeoutMs?: number, maxBytes?: number }) => Promise<Uint8Array>`. Task 3 calls it with no options.

The options exist **only so tests run fast** — a real 15s timeout or a 25 MB body would make the suite unusable. Production always uses the defaults; the route never passes options.

- [ ] **Step 1: Write the failing tests**

Append to `test/remoteGlb.server.test.js`. Add `vi` and `afterEach` to the vitest import, and `fetchRemoteGlb` to the module import:

```js
import { describe, it, expect, vi, afterEach } from 'vitest'
import { assertAllowedGlbUrl, fetchRemoteGlb } from '../app/remoteGlb.server.js'
```

Then append:

```js
// Builds a Response whose body is a stream we control, and reports whether the
// stream was cancelled. Asserting cancellation is the observable proof that an
// oversized body was abandoned mid-flight -- "never buffered" is not directly
// observable, so we assert the thing that is.
function streamingResponse(chunks, { headers = {}, neverEnd = false } = {}) {
  const state = { cancelled: false }
  let i = 0
  const stream = new ReadableStream({
    async pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++])
        return
      }
      if (neverEnd) {
        // Slow drip that stays under the cap and never completes.
        await new Promise((r) => setTimeout(r, 20))
        controller.enqueue(new Uint8Array(1))
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
    // This is the regression test for the demonstrated bug: the old code called
    // bare fetch(), which follows redirects, so https://allowed -> http://internal
    // was fetched. Asserted by outcome, not by the error's identity: Node
    // surfaces a refused redirect as a generic TypeError.
    vi.stubGlobal('fetch', vi.fn(async (_u, init) => {
      expect(init.redirect).toBe('error')
      throw new TypeError('fetch failed')
    }))

    await expect(fetchRemoteGlb(OK_URL)).rejects.toMatchObject({ code: 'FETCH_FAILED' })
  })

  it('tags a timeout FETCH_FAILED rather than letting it bubble uncoded', async () => {
    // An uncoded error becomes a 500 at the route instead of the intended 422.
    const { response } = streamingResponse([new Uint8Array(4)], { neverEnd: true })
    vi.stubGlobal('fetch', vi.fn(async (_u, init) => {
      init.signal.addEventListener('abort', () => response.body.cancel().catch(() => {}))
      return response
    }))

    await expect(
      fetchRemoteGlb(OK_URL, { timeoutMs: 120, maxBytes: 1024 * 1024 }),
    ).rejects.toMatchObject({ code: 'FETCH_FAILED' })
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
    // Proves enforcement does not rely on the header, which can be absent or lie.
    const { response, state } = streamingResponse(
      [new Uint8Array(60), new Uint8Array(60)],
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/remoteGlb.server.test.js`
Expected: FAIL — `fetchRemoteGlb is not a function`.

- [ ] **Step 3: Implement**

In `app/remoteGlb.server.js`, add below the `ALLOWED_HOST` constant:

```js
// 25 MB clears the largest real asset in this repo (12.2 MB, an unoptimised
// export) with headroom. The cap bounds the DOWNLOAD; calibrateUpload then
// parses and re-exports, so peak memory is a multiple of this -- the number is
// chosen to stay clear of Vercel's 1 GB function limit, not merely to be
// generous.
const MAX_GLB_BYTES = 25 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000
```

Append at end of file:

```js
/**
 * Fetches a GLB from an allowlisted host under strict size and time bounds.
 *
 * `redirect: 'error'` is load-bearing. The previous implementation called bare
 * fetch(), which defaults to following redirects and does NOT re-apply the
 * caller's protocol check to the redirect target -- so an attacker-controlled
 * https url redirecting to http://169.254.169.254 was fetched by the server.
 * With a single-host allowlist, any redirect leaves the allowlist by
 * definition, so refusing outright is both safest and simplest. Verified that
 * Shopify's CDN returns a direct 200, so this costs nothing.
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
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw tagged('TOO_LARGE', `declared size ${declared} exceeds ${maxBytes}`)
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/remoteGlb.server.test.js`
Expected: PASS, 19 tests.

- [ ] **Step 5: Lint**

Run: `npx eslint app/remoteGlb.server.js test/remoteGlb.server.test.js`
Expected: 0 problems.

- [ ] **Step 6: Commit**

```bash
git add app/remoteGlb.server.js test/remoteGlb.server.test.js
git commit -m "feat(security): bounded, redirect-refusing GLB fetch

Replaces the SSRF-vulnerable bare fetch: redirects are refused so no
chain can leave the allowlist, size is enforced while streaming rather
than from a Content-Length that can lie, and every fetch rejection is
tagged FETCH_FAILED so none bubbles uncoded into a 500."
```

---

### Task 3: Installed-shop check, quota, and wiring the safe fetch

**Files:**
- Modify: `app/models.server.js:57-100`
- Test: `test/registerModelByUrl.server.test.js`

**Interfaces:**
- Consumes: `fetchRemoteGlb` (Task 2), `tagged` (Task 1).
- Produces: `registerModelByUrl(prisma, url, shop)` unchanged in signature, now throwing tagged errors: `SHOP_INVALID`, `SHOP_NOT_INSTALLED`, `QUOTA_EXCEEDED`, plus whatever `fetchRemoteGlb` throws. Task 4 maps these to statuses.

**Existing tests in this file will break and must be updated in Step 1** — they use `SHOP = 'block-attr-test.myshopify.com'`, which has no `Session` row, so the new installed-shop check rejects them.

- [ ] **Step 1: Update existing tests and add new ones**

In `test/registerModelByUrl.server.test.js`, the fixture shop now needs an installed session. Add this `beforeAll` alongside the existing hooks (keep everything else in the file):

```js
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// The endpoint now refuses to register for a shop with no installed session,
// so the fixture shop needs one.
beforeAll(async () => {
  await prisma.session.deleteMany({ where: { shop: SHOP } })
  await prisma.session.create({
    data: { id: `sess-${SHOP}`, shop: SHOP, state: 'x', accessToken: 't' },
  })
})
```

and add session cleanup to the existing `afterAll`:

```js
  await prisma.session.deleteMany({ where: { shop: SHOP } })
```

Then append the new tests:

```js
describe('registerModelByUrl security gates', () => {
  it('rejects a falsy shop BEFORE querying for a session', async () => {
    // SECURITY-CRITICAL. Prisma drops undefined filters, so
    // session.findFirst({ where: { shop: undefined } }) returns the FIRST
    // SESSION OF ANY SHOP -- the installed-shop check would pass for a request
    // with no shop at all. The shape guard is what prevents that, which makes
    // it part of the security control, not input tidying.
    //
    // Asserting the query never ran is the point: a bare rejects.toThrow()
    // would pass even if the throw came from somewhere after the query.
    const findFirst = vi.fn()
    const spyPrisma = { session: { findFirst }, modelAsset: { findFirst: vi.fn(), count: vi.fn() } }

    for (const bad of [undefined, null, '', 'not-a-shop', 123]) {
      await expect(registerModelByUrl(spyPrisma, URL_A, bad)).rejects.toMatchObject({
        code: 'SHOP_INVALID',
      })
    }
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('rejects a shop with no installed session', async () => {
    const stranger = `not-installed-${randomUUID().slice(0, 8)}.myshopify.com`
    await expect(registerModelByUrl(prisma, URL_A, stranger)).rejects.toMatchObject({
      code: 'SHOP_NOT_INSTALLED',
    })
  })

  it('allows registration at the quota boundary and rejects past it', async () => {
    // Both sides of the boundary. Testing only the rejecting side would pass
    // against an off-by-one that locks merchants out one model early.
    const { MAX_MODELS_PER_SHOP } = await import('../app/models.server.js')
    const quotaShop = `quota-${randomUUID().slice(0, 8)}.myshopify.com`
    const FIRST = 'https://cdn.shopify.com/quota-first.glb'
    const SECOND = 'https://cdn.shopify.com/quota-second.glb'

    await prisma.session.create({
      data: { id: `sess-${quotaShop}`, shop: quotaShop, state: 'x', accessToken: 't' },
    })
    // One short of the limit.
    await prisma.modelAsset.createMany({
      data: Array.from({ length: MAX_MODELS_PER_SHOP - 1 }, (_, i) => ({
        shop: quotaShop,
        storageRef: `quota-${i}.glb`,
        fitMetadata: { version: 'eyewear-v1' },
      })),
    })

    stubFetchReturning(await taggedGlbBytes())

    // At MAX-1: succeeds, taking the shop to exactly MAX.
    const ok = await registerModelByUrl(prisma, FIRST, quotaShop)
    expect(ok.modelUrl).toMatch(/^\/models\/.+\.glb$/)
    expect(await prisma.modelAsset.count({ where: { shop: quotaShop } })).toBe(MAX_MODELS_PER_SHOP)

    // At MAX: rejects.
    await expect(registerModelByUrl(prisma, SECOND, quotaShop)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    })

    // Dedupe must still resolve for a shop at its limit, or a merchant who hits
    // the cap loses access to models they already registered.
    const resolved = await registerModelByUrl(prisma, FIRST, quotaShop)
    expect(resolved.modelUrl).toBe(ok.modelUrl)

    await prisma.modelAsset.deleteMany({ where: { shop: quotaShop } })
    await prisma.session.deleteMany({ where: { shop: quotaShop } })
  })
})
```

Add `randomUUID` to the imports at the top of the file:

```js
import { randomUUID } from 'node:crypto'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/registerModelByUrl.server.test.js`
Expected: FAIL — no `SHOP_INVALID` code, no `MAX_MODELS_PER_SHOP` export.

- [ ] **Step 3: Implement**

In `app/models.server.js`, add to the imports at the top:

```js
import { fetchRemoteGlb } from './remoteGlb.server.js'
import { tagged } from './errors.server.js'
```

Add beside the other module constants:

```js
// Bounds S3 and database growth from the public registration endpoint. Dedupe
// by (shop, sourceUrl) already prevents re-calibrating the same file, so the
// realistic attack requires uploading many distinct GLBs to Shopify's CDN.
export const MAX_MODELS_PER_SHOP = 50
```

Replace the shape guard and the fetch in `registerModelByUrl` so the function begins:

```js
export async function registerModelByUrl(prisma, url, shop) {
  // SECURITY-LOAD-BEARING, and it runs first for a reason.
  //
  // Beyond keeping rows attributable (so shop/redact can erase them), this
  // guard is what makes the installed-shop check below sound. Prisma DROPS
  // undefined filter values, so session.findFirst({ where: { shop: undefined } })
  // returns the first session of ANY shop -- a request with no shop would find
  // "a" session and pass the gate. Never relax this or move it below the
  // session lookup.
  if (!shop || typeof shop !== 'string' || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
    throw tagged('SHOP_INVALID', `invalid shop: ${String(shop)}`)
  }

  // This endpoint is public and unauthenticated, so `shop` is caller-supplied.
  // This check proves the named shop is an installed customer. It does NOT
  // prove the caller IS that shop -- shop A's storefront can still register a
  // GLB under shop B's name. The allowlist and quota bound the residual abuse.
  // Real authentication means App Proxy; see the spec's Out of scope.
  const installed = await prisma.session.findFirst({ where: { shop }, select: { id: true } })
  if (!installed) {
    throw tagged('SHOP_NOT_INSTALLED', `shop has no installed session: ${shop}`)
  }

  const existing = await prisma.modelAsset.findFirst({ where: { shop, sourceUrl: url } })
  if (existing) {
    return { modelUrl: `/models/${existing.id}.glb`, fitMetadata: existing.fitMetadata }
  }

  // After dedupe: a merchant at the limit must still resolve models they have
  // already registered.
  const owned = await prisma.modelAsset.count({ where: { shop } })
  if (owned >= MAX_MODELS_PER_SHOP) {
    throw tagged('QUOTA_EXCEEDED', `shop at model limit (${MAX_MODELS_PER_SHOP})`)
  }

  const glbBytes = await fetchRemoteGlb(url)
```

Delete the old lines that performed the raw fetch:

```js
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status}`)
  }
  const glbBytes = new Uint8Array(await response.arrayBuffer())
```

The rest of the function (calibrate, store, persist) is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/registerModelByUrl.server.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all suites pass except `test/api.register-model.test.js`, which still asserts the old CORS header and old error text — Task 4 fixes it. Note which tests fail so Task 4 can confirm it fixed exactly those.

- [ ] **Step 6: Commit**

```bash
git add app/models.server.js test/registerModelByUrl.server.test.js
git commit -m "feat(security): installed-shop check, quota, and safe fetch

Registration now requires the named shop to have an installed session and
stays under a per-shop model quota, and fetches through the allowlisted
bounded fetcher instead of a bare fetch.

The shape guard is now security-load-bearing: without it Prisma drops the
undefined filter and the session lookup returns another shop's row,
turning the installed-check into a false pass. Pinned by a test asserting
the query never runs."
```

---

### Task 4: Route error mapping and CORS removal

**Files:**
- Modify: `app/routes/api.register-model.jsx`
- Test: `test/api.register-model.test.js`

**Interfaces:**
- Consumes: the tagged errors from Task 3.
- Produces: the public endpoint's final response contract.

- [ ] **Step 1: Rewrite the tests**

Replace the whole of `test/api.register-model.test.js`. The existing file asserts `Access-Control-Allow-Origin: '*'` and matches `/shop is required/`; both are intentionally gone.

```js
import { describe, it, expect, vi, afterEach } from 'vitest'

const hoisted = vi.hoisted(() => ({ error: null, result: null }))

vi.mock('../app/models.server.js', () => ({
  registerModelByUrl: async () => {
    if (hoisted.error) throw hoisted.error
    return hoisted.result
  },
}))
vi.mock('../app/db.server.js', () => ({ default: {} }))

const { loader } = await import('../app/routes/api.register-model.jsx')

const call = (url) => loader({ request: new Request(url) })
const GOOD = 'https://app.test/api/register-model?url=https%3A%2F%2Fcdn.shopify.com%2Fa.glb&shop=s.myshopify.com'

afterEach(() => {
  hoisted.error = null
  hoisted.result = null
})

describe('GET /api/register-model', () => {
  it('returns 400 when url is missing', async () => {
    expect((await call('https://app.test/api/register-model?shop=s.myshopify.com')).status).toBe(400)
  })

  it('returns 400 when shop is missing', async () => {
    expect((await call('https://app.test/api/register-model?url=https%3A%2F%2Fcdn.shopify.com%2Fa.glb')).status).toBe(400)
  })

  it.each([
    ['URL_NOT_ALLOWED', 400],
    ['SHOP_INVALID', 400],
    ['SHOP_NOT_INSTALLED', 403],
    ['QUOTA_EXCEEDED', 429],
    ['FETCH_FAILED', 422],
    ['TOO_LARGE', 422],
  ])('maps %s to %i', async (code, status) => {
    hoisted.error = Object.assign(new Error('internal detail'), { code })
    expect((await call(GOOD)).status).toBe(status)
  })

  it('fails closed to 500 for an uncoded error', async () => {
    // A new throw site that forgets to tag must not leak its message.
    hoisted.error = new Error('some raw internal failure')
    expect((await call(GOOD)).status).toBe(500)
  })

  it.each([
    ['URL_NOT_ALLOWED'], ['SHOP_NOT_INSTALLED'], ['QUOTA_EXCEEDED'],
    ['FETCH_FAILED'], ['TOO_LARGE'],
  ])('never leaks the internal message for %s', async (code) => {
    hoisted.error = Object.assign(new Error('SECRET-INTERNAL-DETAIL'), { code })
    const body = await (await call(GOOD)).text()
    expect(body).not.toContain('SECRET-INTERNAL-DETAIL')
  })

  it('does not leak the internal message on an uncoded 500', async () => {
    hoisted.error = new Error('SECRET-INTERNAL-DETAIL')
    const body = await (await call(GOOD)).text()
    expect(body).not.toContain('SECRET-INTERNAL-DETAIL')
  })

  it('sends no CORS header — the engine is same-origin', async () => {
    hoisted.result = { modelUrl: '/models/x.glb', fitMetadata: { version: 'eyewear-v1' } }
    const res = await call(GOOD)
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/api.register-model.test.js`
Expected: FAIL — the route still returns CORS headers and does not map codes.

- [ ] **Step 3: Implement**

Replace the whole of `app/routes/api.register-model.jsx`:

```jsx
import db from '../db.server'
import { registerModelByUrl } from '../models.server'

// Public: the hosted engine (theme iframe) calls this with a merchant's
// Shopify-Files GLB URL. We calibrate + cache it once (keyed by shop+URL) and
// return the served model URL + fit metadata.
//
// No CORS headers: the engine is served from this app at /tryon/index.html and
// issues relative requests, so these calls are same-origin. The theme block
// itself makes no network calls -- verified 2026-07-24 that the extension
// contains no fetch/XHR at all. If the block ever gains client-side logic that
// calls this endpoint, it needs App Proxy, NOT a restored wildcard ACAO.

// Errors carry a machine-readable `code`; we map code -> status here and never
// forward err.message. An unrecognised code falls through to 500 so a new throw
// site fails closed instead of leaking whatever it happened to say.
const STATUS_BY_CODE = {
  URL_NOT_ALLOWED: [400, 'model url must be hosted on cdn.shopify.com'],
  SHOP_INVALID: [400, 'invalid request'],
  SHOP_NOT_INSTALLED: [403, 'shop not found'],
  QUOTA_EXCEEDED: [429, 'model limit reached'],
  FETCH_FAILED: [422, 'could not retrieve model'],
  TOO_LARGE: [422, 'could not retrieve model'],
}

export const loader = async ({ request }) => {
  const url = new URL(request.url)
  const modelUrl = url.searchParams.get('url')
  const shop = url.searchParams.get('shop')

  if (!modelUrl || !shop) {
    return Response.json({ error: 'invalid request' }, { status: 400 })
  }

  try {
    return Response.json(await registerModelByUrl(db, modelUrl, shop))
  } catch (error) {
    const [status, message] = STATUS_BY_CODE[error?.code] ?? [500, 'registration failed']
    console.error(
      JSON.stringify({
        event: 'register_model_failed',
        code: error?.code ?? 'UNCODED',
        shop,
        detail: error?.message,
        at: new Date().toISOString(),
      }),
    )
    return Response.json({ error: message }, { status })
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/api.register-model.test.js`
Expected: PASS, 18 tests.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint app/routes/api.register-model.jsx test/api.register-model.test.js
git add app/routes/api.register-model.jsx test/api.register-model.test.js
git commit -m "feat(security): map error codes to statuses, drop CORS

Replaces prose-matching on err.message with a code->status table, and
stops forwarding internal messages to clients. Unrecognised codes fail
closed to 500. Removes the vestigial wildcard ACAO."
```

---

### Task 5: Remove CORS from the two remaining public endpoints

**Files:**
- Modify: `app/routes/api.tryon-config.jsx`
- Modify: `app/routes/models.$assetId[.]glb.jsx`
- Test: `test/tryonConfig.route.test.js` (create)
- Test: `test/modelsGlb.route.test.js` (create)

**Interfaces:** none produced.

- [ ] **Step 1: Write the failing test**

Create `test/tryonConfig.route.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'

vi.mock('../app/db.server.js', () => ({
  default: { productMapping: { findUnique: async () => null } },
}))

const { loader } = await import('../app/routes/api.tryon-config.jsx')

describe('GET /api/tryon-config', () => {
  // Locks an exit criterion that is otherwise enforced only by review: a future
  // refactor copying the old header block would silently reopen these to every
  // origin on the web.
  it('sends no CORS header on a 400', async () => {
    const res = await loader({ request: new Request('https://app.test/api/tryon-config') })
    expect(res.status).toBe(400)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('sends no CORS header on a 404', async () => {
    const res = await loader({
      request: new Request('https://app.test/api/tryon-config?shop=s.myshopify.com&productId=gid%3A%2F%2Fshopify%2FProduct%2F1'),
    })
    expect(res.status).toBe(404)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})
```

Also create `test/modelsGlb.route.test.js`. The GLB route only ever set `ACAO`
on its **200** path, so a 404-only test would pass without the fix and prove
nothing — this must exercise the success path:

```js
import { describe, it, expect, vi } from 'vitest'

vi.mock('../app/db.server.js', () => ({
  default: {
    modelAsset: {
      findUnique: async () => ({ id: 'abc', storageRef: 'abc.glb' }),
    },
  },
}))
vi.mock('../app/storage.server.js', () => ({
  readModelGlb: async () => Buffer.from([1, 2, 3]),
}))

const { loader } = await import('../app/routes/models.$assetId[.]glb.jsx')

describe('GET /models/:assetId.glb', () => {
  it('serves the GLB with no CORS header but keeps caching', async () => {
    // ACAO was only ever set on the 200 path, so this must hit success --
    // a 404-path test would pass without the change and prove nothing.
    const res = await loader({ params: { assetId: 'abc' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(res.headers.get('Content-Type')).toBe('model/gltf-binary')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/tryonConfig.route.test.js test/modelsGlb.route.test.js`
Expected: FAIL — the header is still `*` on both.

- [ ] **Step 3: Implement**

Replace `app/routes/api.tryon-config.jsx`:

```jsx
import db from '../db.server'
import { getTryonConfig } from '../tryonConfig.server'

// Public endpoint: the hosted engine (inside the theme iframe) fetches this to
// learn its model URL + fit-metadata for a given shop+product.
//
// No CORS headers: the engine is served from this app and issues relative
// requests, so this is same-origin. The theme block makes no network calls of
// its own -- verified 2026-07-24.
//
// Left unauthenticated deliberately. NOTE the reason is NOT "unguessable id":
// this is keyed by (shop, productId), both of which are guessable, and it hands
// out the asset UUID. It is open because it returns the same public product
// data any storefront visitor already receives by opening the try-on on that
// product page. If it ever returns anything non-public, revisit this.
export const loader = async ({ request }) => {
  const url = new URL(request.url)
  const shop = url.searchParams.get('shop')
  const productId = url.searchParams.get('productId')
  if (!shop || !productId) {
    return new Response('shop and productId required', { status: 400 })
  }
  const cfg = await getTryonConfig(db, shop, productId)
  if (!cfg) return new Response('not found', { status: 404 })
  return Response.json(cfg)
}
```

In `app/routes/models.$assetId[.]glb.jsx`, delete the `'Access-Control-Allow-Origin': '*',` line from the response headers and update the comment. The headers block becomes:

```jsx
  return new Response(bytes, {
    headers: {
      'Content-Type': 'model/gltf-binary',
      'Cache-Control': 'public, max-age=3600',
    },
  })
```

and the file's top comment becomes:

```jsx
// Public: stream the stored normalized GLB for an asset. No CORS headers -- the
// engine is served from this app and requests it relatively, so this is
// same-origin. assetId is a genuinely unguessable UUID (ModelAsset.id is
// @default(uuid())).
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add app/routes/api.tryon-config.jsx app/routes/models.$assetId\[.\]glb.jsx test/tryonConfig.route.test.js test/modelsGlb.route.test.js
git commit -m "feat(security): drop wildcard CORS from remaining public routes

Both are same-origin to the engine, so the headers were vestigial while
letting any website read them. Corrects the tryon-config comment: it is
keyed by guessable (shop, productId) and is open because its data is
public, not because anything about it is unguessable."
```

---

### Task 6: Verify the SSRF is actually closed

A unit test with a stubbed `fetch` proves the code refuses redirects. It does not prove the deployed endpoint refuses them. This task exercises the real thing.

**Files:** none — verification only.

- [ ] **Step 1: Confirm the allowlist rejects the demonstrated attack locally**

Run from `apps/shopify-app`. The `--input-type=module` flag must come **before**
`-e`, and works because the app's `package.json` sets `"type": "module"`
(verified).

```bash
node --input-type=module -e "
const { assertAllowedGlbUrl } = await import('./app/remoteGlb.server.js')
const attacks = [
  'https://169.254.169.254/latest/meta-data/',
  'http://cdn.shopify.com/a.glb',
  'https://cdn.shopify.com.attacker.net/a.glb',
  'https://evil-cdn.shopify.com/a.glb',
  'https://cdn.shopify.com@evil.com/a.glb',
]
for (const a of attacks) {
  try { assertAllowedGlbUrl(a); console.log('LEAK:', a) }
  catch (e) { console.log('blocked', e.code, a) }
}
"
```

Expected: `blocked URL_NOT_ALLOWED` for all five, no `LEAK:` line.

- [ ] **Step 2: Confirm a real Shopify CDN URL still works end to end**

```bash
node --input-type=module -e "
const { fetchRemoteGlb } = await import('./app/remoteGlb.server.js')
const bytes = await fetchRemoteGlb('https://cdn.shopify.com/s/files/1/0868/5862/9313/files/gripzpelmo.glb?v=1783771184')
console.log('fetched', bytes.byteLength, 'bytes')
console.log(bytes.byteLength === 2768571 ? 'OK exact size match' : 'size differs - investigate')
"
```

Expected: `fetched 2768571 bytes` and `OK exact size match`. A failure here means the allowlist broke the legitimate path. (This is the one step that makes a real network call.)

- [ ] **Step 3: Merge and deploy**

This work is done on a feature branch, and **Vercel deploys from `main`** — pushing the branch produces a preview, not production. Merge first:

```bash
cd "D:/AR Sunglasses/ar-tryon-prototype"
git checkout main
git merge --ff-only <feature-branch>
git push origin main
```

If the merge is not a fast-forward, stop and reconcile rather than forcing it.

Wait for the Vercel deployment to finish before running Step 4 — otherwise you
are testing the previous build and will get a false pass.

- [ ] **Step 4: Verify against the live endpoint**

```bash
B=https://ar-sunglasses-shopify-app.vercel.app
for u in \
  "https://169.254.169.254/latest/meta-data/" \
  "http://cdn.shopify.com/a.glb" \
  "https://cdn.shopify.com.attacker.net/a.glb" \
  "https://evil.com/a.glb" ; do
  printf "%-45s -> " "$u"
  curl -s -o /dev/null -w "%{http_code}\n" "$B/api/register-model?shop=x.myshopify.com&url=$(node -p "encodeURIComponent('$u')")"
done
```

Expected: `400` for every one. Any `422` or `502` would mean the request was attempted rather than rejected.

- [ ] **Step 5: Confirm no CORS header is served in production**

```bash
B=https://ar-sunglasses-shopify-app.vercel.app
for p in "api/register-model?shop=x.myshopify.com&url=https%3A%2F%2Fcdn.shopify.com%2Fa.glb" "api/tryon-config" ; do
  printf "%-20s ACAO: " "${p%%\?*}"
  curl -s -D - -o /dev/null "$B/$p" | grep -i "access-control-allow-origin" || echo "(absent)"
done
```

Expected: `(absent)` for both.

- [ ] **Step 6: Commit the verification record**

```bash
git commit --allow-empty -m "chore(phase3): SSRF closed, verified live

Allowlist rejects the metadata endpoint, plain http, and both endsWith
bypasses; a real CDN url still fetches byte-exact. Live endpoint returns
400 for every attack url and serves no ACAO header."
git push
```

---

## Exit Criteria

- [ ] `register-model` fetches only from `cdn.shopify.com`, over https, refusing redirects (Tasks 1, 2; live Task 6 Step 4).
- [ ] An over-cap body is aborted mid-stream, not buffered (Task 2, asserted via stream cancellation).
- [ ] Registration rejected for shops with no installed session (Task 3).
- [ ] Per-shop model count bounded (Task 3).
- [ ] No internal error text reaches a client (Task 4).
- [ ] `ACAO` removed from all three public endpoints (Tasks 4, 5; live Task 6 Step 5).
- [ ] The falsy-shop path rejects before any session query (Task 3 — the test that keeps the installed-check from becoming a false pass).
