# Phase 4 Slice 1 — Perf & Reliability: design notes for a fresh session

**Status:** brainstorming in progress, NOT yet a spec. Design was drafted, reviewed,
and the review found two real gaps. **Start here, do not re-derive.**

**Scope decision already made:** Phase 4 is six loosely-coupled workstreams
(A cache-buster, B DB pool, C payload trim, D monitoring, E device matrix,
F accessibility). User chose to slice it. **Slice 1 = A + B + C**, then C was cut
(see below). D/E/F are later slices, each with its own spec→plan→build.

---

## Measurements already taken — trust these, don't redo

| Fact | Value | How measured |
|---|---|---|
| First-load, app-served, default SKU | **1.48 MB** | fetched all 9 assets from production |
| Deployed engine size | 15 MB | `du` on committed `public/tryon` |
| `/tryon/*` cache-control | `public, max-age=0, must-revalidate` | HEAD against production |
| **`/models/:id.glb` cache-control** | **`public, max-age=3600`** | source, `models.$assetId[.]glb.jsx:22` |
| Cache-buster gating | none — unconditional | `arConfig.js:270` |

Per-asset first-load breakdown: three 540 KB, mediapipe 123 KB,
MediaPipeThreeProvider 112 KB, draco wasm 188 KB, draco wrapper 57 KB,
default GLB 472 KB, main 15 KB, css 6 KB, html 2 KB.

---

## THE REFRAME (user endorsed explicitly — build on this)

**Caching beats trimming, decisively.** Customers pull 1.48 MB and re-pull it
every visit. Caching converts "pay 1.48 MB every visit" → "pay once". Trimming
the 15 MB deployed engine does nothing for a customer who only ever pulls
1.48 MB of it.

**The find that justified measuring first:** there are **TWO independent**
caching defects, and the roadmap only named one.

1. *Code side* — `getGlassesModelUrl()` appends `?v=${Date.now()}` unconditionally.
2. *Serving side* — `/tryon/*` is served `max-age=0, must-revalidate` (Vercel's
   default for unmatched static routes).

**Fixing only #1 (what the roadmap said) would have achieved close to nothing** —
it would have shipped, verified "cache-buster removed", and left the feature
uncached. Only checking the *served headers* surfaced #2.

**C (payload trim) is CUT from this slice.** The measurement killed its rationale.
Side benefit the user noted: with C cut, nothing in A/B touches the Vite build
config or the calibration harness, so the harness-regression risk is moot.
Deploy-size reduction is a standalone chore if ever wanted.

---

## Design as drafted (A + B), WITH the two review gaps to close

### A. Cache-buster → gate to dev
`arConfig.js:270` → `import.meta.env.DEV ? \`?v=${Date.now()}\` : ''`. Vite
statically replaces this so the string compiles OUT of the production bundle.
Dev keeps "always fetch a fresh re-export".

Only caller: `MediaPipeThreeProvider.js:122` (`loadSku`). Merchant block models
flow through the SAME function — `registerRuntimeGlassesConfig` sets
`runtimeModelPath` to the app's `/models/:id.glb` — so this defect hits real
customers, not just dev.

### B. Cache headers
`vercel.json` for the static `/tryon/*` paths, **plus the merchant route** (gap 1).

---

## ⚠️ REVIEW GAP 1 — merchant `/models/:id.glb` is uncovered and is the MOST
## valuable header in the slice. VERIFIED.

The draft cached `/tryon/*` via `vercel.json`, which only matches static paths.
`/models/:id.glb` is a **dynamic app route** — its cache-control must be set in
the loader response, not `vercel.json`. So the draft cached the bundled default
SKU and left the **actual customer-facing merchant models uncached**, which is
backwards for a fix justified by "this hits real customers".

**Verified in source:** `app/routes/models.$assetId[.]glb.jsx:22` emits
`'Cache-Control': 'public, max-age=3600'`. One hour — on an asset addressed by
an **unguessable UUID that can never change** (`ModelAsset.id` is
`@default(uuid())`; a new upload gets a new id). Safe to cache hard, forever.

**Action:** change that loader header to `public, max-age=31536000, immutable`.
Highest-value single change in the slice.

## ⚠️ REVIEW GAP 2 — `immutable` is only safe on content-addressed paths. VERIFIED.

Checked the actual filenames:

- `/tryon/assets/*` — **Vite content-hashed** (`three-DXBMKiNx.js`,
  `main-CeAMvQLy.js`, …). ✅ safe for `immutable`.
- `/tryon/models/*` — **STABLE names** (`sunglasses-draco.glb`,
  `gripz1-draco.glb`, …). ❌ NOT safe.
- `/tryon/draco/*` — **STABLE names** (`draco_decoder.wasm`, …). ❌ NOT safe.

Marking the stable-named ones `immutable` would serve a stale model or decoder
for a year after any re-export — the same stale-asset defect the cache-buster
exists to prevent, inverted. **For those: use a revalidating or shorter TTL
(e.g. `max-age=86400, stale-while-revalidate`), or version the filenames.**

Note the asymmetry that makes this coherent: the *merchant* models ARE
content-addressed (UUID), so they get `immutable`; the *bundled* engine models
are not, so they do not.

## ⚠️ REVIEW GAP 3 (medium) — DB fix has adjacent conditions to confirm

`connection_limit=1` is the right serverless+PgBouncer fix but only against the
**pooled** endpoint. Before/while doing it, confirm:

- `DATABASE_URL` points at Neon's **pooler** string, not the direct one (on
  direct, `=1` would over-throttle). *Known from this session: the host is
  `ep-solitary-breeze-as0s37zn-pooler...` — pooled. Confirm the final value.*
- **`pgbouncer=true`** is present so Prisma disables prepared statements in
  transaction-pooling mode.
- **`directUrl`** is configured for migrations, so `prisma migrate deploy` (which
  runs on every git-push deploy) is not itself throttled to one connection.

**Make verification ACTIVE, not a wait-and-see.** "Watch for absence of
pool-timeout errors" proves a negative. Instead: reproduce the concurrent load
that previously produced `Timed out fetching a new connection` and assert it now
succeeds, or check Neon's metrics show ≤1 connection per instance.

**This step is the USER'S** — it edits the Vercel env var / DB URL. I do not
enter credentials, DB URLs, or secrets.

Context: `app/db.server.js` creates a bare `new PrismaClient()` with no explicit
pool config, so the limit comes entirely from the connection string. Observed in
production runtime logs this session: `Timed out fetching a new connection from
the connection pool (timeout: 10, connection limit: 5)` plus misleading
`Prisma session table does not exist` (that error is what Shopify's session
storage reports when the CONNECTION fails, not a real missing table).

**Honest note:** I contributed to the pool pressure by running the full test
suite against this production database many times during Phases 2–3.

---

## Verification plan (Section 4 as drafted, + review's precision fix)

- **Unit:** `getGlassesModelUrl` returns a bare URL in prod mode, `?v=` in dev.
- **Live before/after:** assert each asset's `cache-control` matches its tier —
  `immutable` only on `/tryon/assets/*` and `/models/:id.glb`; revalidating on
  `index.html`; bounded TTL on the stable-named model/draco paths.
- **The real proof (review's precision fix):** fetch an asset twice and assert
  **`x-vercel-cache: HIT`** on the second fetch (or `age` incremented above 0) —
  a named signal, not a vague "is it cached".
- **DB:** active concurrent-load reproduction, per gap 3.

---

## Working agreements carried from this session

- Dev and production **share one Neon database**. Test fixtures must be
  `randomUUID()`-tagged and cleaned by **exact name**, never by prefix — a
  pattern filter can match rows we did not create. A failed test skips its own
  cleanup, so track fixtures and clean in `afterAll`.
- **A green local build does not prove a green Vercel build.** Local has all
  packages; Vercel prunes devDeps and resolves temp configs differently. Test
  deploy-time resolution by hiding the package and checking the config *loads*.
- **Keep `vite.config` free of application runtime imports.**
- The engine is now a **committed artifact** at `apps/shopify-app/public/tryon`
  (~15 MB, trimmed). Regenerate with `npm run build:engine` from the repo root;
  `.gitignore` auto-excludes the dead weight; `.gitattributes` keeps GLB/WASM
  binary. **Do not** re-add a Vercel-side engine build.
- Subagent dispatches were intermittently refused by the auto-mode classifier.
  Review-only dispatches sometimes succeed where implementer ones do not. Retry
  once, then fall back to inline execution and say so plainly.

## Next step for the fresh session

Re-enter `superpowers:brainstorming`, incorporate the three gaps above into the
design, present it, then write the spec to
`docs/superpowers/specs/2026-07-25-phase4-slice1-design.md` and proceed to
`superpowers:writing-plans`. **Do not redo the measurements or the scope
decision.**
