# Phase 4 Slice 1 — Perf & Reliability: caching and connection pooling

**Status:** approved design, ready for `superpowers:writing-plans`.

Supersedes the brainstorming notes in `2026-07-25-phase4-slice1-handoff.md`. Where
the two disagree, this document wins — several of the handoff's assumptions were
checked against source and turned out to be wrong (see *Corrections* below).

---

## 1. Scope

Phase 4 is six loosely-coupled workstreams: A cache-buster, B DB pool, C payload
trim, D monitoring, E device matrix, F accessibility.

**This slice is A + B.** C is cut permanently — see §2. D, E and F are later
slices, each with its own spec → plan → build.

## 2. Rationale — caching beats trimming

Measured against production, a first load of the app-served default SKU is
**1.48 MB** across 9 assets:

| Asset | Size |
|---|---|
| `three-*.js` | 540 KB |
| default GLB (`sunglasses-draco.glb`) | 472 KB |
| `draco_decoder.wasm` | 188 KB |
| `mediapipe-*.js` | 123 KB |
| `MediaPipeThreeProvider-*.js` | 112 KB |
| `draco_wasm_wrapper.js` | 57 KB |
| `main-*.js` | 15 KB |
| `main-*.css` | 6 KB |
| `index.html` | 2 KB |

Customers re-pull all of it on every visit. Caching converts "pay 1.48 MB every
visit" into "pay once". Trimming the 15 MB deployed engine does nothing for a
customer who only ever pulls 1.48 MB of it — which is why **C is cut**. Reducing
deploy size is a standalone chore if ever wanted.

A side benefit of cutting C: nothing in this slice touches the Vite build config
or the calibration harness, so the harness-regression risk is moot.

There are **two independent** caching defects, not one:

1. *Code side* — `getGlassesModelUrl()` appends `?v=${Date.now()}` unconditionally.
2. *Serving side* — `/tryon/*` is served `public, max-age=0, must-revalidate`
   (Vercel's default for unmatched static routes).

Fixing only #1 would have shipped, verified "cache-buster removed", and left the
feature uncached. Only checking the *served headers* surfaced #2.

## 3. Why A and B are a single slice

Gap 1 of the handoff correctly identified `/models/:id.glb` → `immutable` as the
highest-value single change. **That change is worth nothing on its own.**

`getGlassesModelUrl()` appends `?v=${Date.now()}`, and merchant block models flow
through that same function. `registerRuntimeGlassesConfig` (`arConfig.js:231`)
assigns the app's `/models/:id.glb` URL to *all four* path fields — `modelPath`,
`normalizedModelPath`, `runtimeModelPath` and `optimizedModelPath` — and sets both
`useNormalizedModel` and `useOptimizedModel` to `false`. So for merchant models
`getGlassesModelUrl` actually resolves through its **`else` branch and returns
`config.modelPath`**, not `runtimeModelPath`. The suffix is appended either way,
but a test that exercises only the `runtimeModelPath` branch would not be testing
the merchant path.

Every load therefore requests a *different URL*. A distinct cache key per visit
means the CDN never registers a hit regardless of what the response header says.

A is the precondition that makes B's best header reachable. Neither half delivers
value alone. That is the slice boundary.

## 4. Workstream A — gate the cache-buster to dev

`src/config/arConfig.js:270-285`. `MODEL_CACHE_BUST = Date.now()` is appended by
`getGlassesModelUrl()` on every call, unconditionally.

Gate it on `import.meta.env.DEV` so Vite statically replaces the expression and
the string is eliminated from the production bundle. Dev keeps its "always fetch
a freshly re-exported GLB" behaviour.

Sole call site: `src/tryon/providers/MediaPipeThreeProvider.js:122` (`loadSku`).

## 5. Workstream B — cache headers

The governing rule: **`immutable` only where the URL changes when the bytes
change.** Marking a stable-named path `immutable` would serve a stale model or
decoder for a year after a re-export — the same stale-asset defect the
cache-buster exists to prevent, inverted.

| Path | Naming | Header | Set in |
|---|---|---|---|
| `/tryon/assets/*` | Vite content-hashed | `public, max-age=31536000, immutable` | `vercel.json` |
| `/tryon/models/*` | stable | `public, max-age=86400, stale-while-revalidate=604800` | `vercel.json` |
| `/tryon/draco/gltf/*` | stable | `public, max-age=86400, stale-while-revalidate=604800` | `vercel.json` |
| `/tryon/index.html` | stable, entry point | `public, max-age=0, must-revalidate` | `vercel.json` |
| `/models/:id.glb` | UUID, content-addressed | `public, max-age=31536000, s-maxage=31536000, immutable` | route loader |

Note the asymmetry that makes this coherent: *merchant* models are
content-addressed (`ModelAsset.id` is `@default(uuid())`, and a new upload gets a
new id), so they get `immutable`; the *bundled* engine models are not, so they do
not.

`index.html` stays revalidating because it is the entry point that must always
resolve to the current hashed bundles.

Actual filenames verified in `apps/shopify-app/public/tryon`:

- `assets/` — `three-DXBMKiNx.js`, `main-CeAMvQLy.js`, `main-gy1dM4xb.css`,
  `mediapipe-dSeFstGv.js`, `MediaPipeThreeProvider-BjTTIkGq.js`,
  `calibrate-ELF2N1yw.js`, `modulepreload-polyfill-B5Qt9EMX.js` — all hashed.
- `models/` — `sunglasses-draco.glb`, `gripz1-draco.glb`, `gripz2-draco.glb`,
  `gripzpelmo-draco.glb` — all stable.
- `draco/gltf/` — `draco_decoder.js`, `draco_decoder.wasm`,
  `draco_wasm_wrapper.js` — all stable.

### 5.1 `vercel.json` is created, not edited

**No `vercel.json` exists anywhere in the repository.** It is created at
`apps/shopify-app/vercel.json`, because Vercel's Root Directory is
`apps/shopify-app` (documented at `apps/shopify-app/.gitignore:16`). The engine
reaches production as committed static files that `react-router build` copies
from `public/` into `build/client/`.

### 5.2 `s-maxage` on the merchant route

`/models/:id.glb` is a dynamic app route, so its header is set in the loader —
`apps/shopify-app/app/routes/models.$assetId[.]glb.jsx:22`, currently
`public, max-age=3600`.

It needs **`s-maxage` in addition to `max-age`**. Vercel's Edge Network keys
function-response caching off `s-maxage` / `CDN-Cache-Control`, not plain
`max-age`. With `max-age` alone we would get browser caching, but every cold
browser would still execute the function: a `db.modelAsset.findUnique` plus a
storage fetch.

This produces a direct interaction between the two halves of the slice:
**edge-caching `/models/:id.glb` removes a database query per model load**,
relieving the same connection-pool pressure §6 addresses.

## 6. Workstream B (DB) — connection pooling

`apps/shopify-app/app/db.server.js` creates a bare `new PrismaClient()` with no
explicit pool configuration, so the limit comes entirely from the connection
string. The `global.prismaGlobal` cache is guarded by `NODE_ENV !== "production"`,
so in production every lambda instance gets its own client with Prisma's default
pool — the observed `connection limit: 5`. Multiplied across concurrent instances
against one PgBouncer endpoint, this produced, in production runtime logs:

```
Timed out fetching a new connection from the connection pool
(timeout: 10, connection limit: 5)
```

plus a misleading `Prisma session table does not exist` — which is what Shopify's
session storage reports when the *connection* fails, not a real missing table.

### 6.1 Division of work

These interleave rather than splitting cleanly into operator and code work — see
the strict ordering in §6.2.

**Operator steps (touch secrets — Claude does not enter DB URLs or credentials):**

- ~~Confirm `DATABASE_URL` points at Neon's **pooled** endpoint.~~ **Confirmed
  2026-07-26:** it is the pooled `-pooler` host. This mattered because on the
  direct endpoint `connection_limit=1` would over-throttle.
- Add a `DIRECT_URL` environment variable pointing at Neon's **direct**
  (non-pooler) endpoint — the same string with `-pooler` removed from the host.
  Set it in Vercel across Production, Preview and Development, and in local
  `apps/shopify-app/.env`. *(Phase 1.)*
- Append `connection_limit=1&pgbouncer=true` to `DATABASE_URL` in Vercel.
  `pgbouncer=true` makes Prisma disable prepared statements, required in
  transaction-pooling mode. *(Phase 3 — after the schema change, not before.)*

**Code step:**

- Add `directUrl = env("DIRECT_URL")` to the `datasource db` block in
  `apps/shopify-app/prisma/schema.prisma`. It is currently absent — the datasource
  is only `url = env("DATABASE_URL")`. *(Phase 2.)*

### 6.2 Sequencing — three phases, and the plan must enforce the order

The Vercel Build Command includes `prisma migrate deploy`, so migrations run on
every git push. This creates **two** independent ways to break a deploy, pulling
in opposite directions:

- If the `directUrl` schema change merges *before* `DIRECT_URL` exists in Vercel,
  Prisma fails with `Environment variable not found: DIRECT_URL` and the build
  fails outright.
- If `connection_limit=1&pgbouncer=true` lands on `DATABASE_URL` *before*
  `directUrl` is in effect, migrations still run through PgBouncer — where they
  can fail because migrations need **session-level advisory locks that
  transaction-mode pooling cannot hold**, independently of the connection limit.

So the three changes cannot be grouped into "operator work" and "code work". They
form a strict three-phase sequence:

| Phase | Actor | Change | Why it is safe here | Status |
|---|---|---|---|---|
| 1 | operator | Add `DIRECT_URL` to Vercel (all three environments) **and** to local `apps/shopify-app/.env` | Nothing reads it yet — zero risk | ✅ **done 2026-07-26** |
| 2 | code | Add `directUrl = env("DIRECT_URL")` to `schema.prisma`; merge and deploy | The variable now exists; migrations route to the direct endpoint | pending |
| 3 | operator | Append `connection_limit=1&pgbouncer=true` to `DATABASE_URL` | Migrations are already insulated by phase 2 | pending |

Phase 1 verification (2026-07-26): local `DATABASE_URL` and `DIRECT_URL` were
confirmed byte-identical apart from `-pooler` — same endpoint
(`ep-solitary-breeze-as0s37zn`), region, database, credentials and query string.
Vercel has `DIRECT_URL` across Production, Preview and Development.

Note for phase 3: the connection string already carries
`?sslmode=require&channel_binding=require`, so the new parameters append with `&`.

Two details that are easy to lose:

- **Local `.env` needs `DIRECT_URL` too.** After phase 2, `schema.prisma`
  references it, so local `prisma generate` / `migrate` / `npm run setup` fail
  without it. `.env` is gitignored (`apps/shopify-app/.gitignore:40`); the
  variable is documented in `.env.example`.
- **Append `DATABASE_URL` parameters with `&`, not `?`.** Neon connection strings
  already end in `?sslmode=require`.

Phase 1 must cover Preview as well as Production, since preview deploys run the
same build command and would otherwise start failing the moment phase 2 lands.

## 7. Verification

### 7.1 Unit and build

- `getGlassesModelUrl` returns a bare URL under production mode and a `?v=`
  suffixed URL under dev mode.
- **Separately, grep the built production bundle for `?v=`.** The unit test can
  pass while Vite still emits the string; only the bundle check proves the static
  elimination that §4 depends on.

### 7.2 Live headers

- Assert each path's `cache-control` matches its tier in the §5 table.
- **The real proof:** fetch an asset twice and assert `x-vercel-cache: HIT` on the
  second fetch, or `age` incremented above 0. A named signal, not a vague "is it
  cached".

**Do not assume `vercel.json` engages.** Applying headers to `public/` content
copied into the client build by the `@vercel/react-router` preset is exactly the
kind of thing that can silently no-op. The header assertions above are the test
that it worked at all. If it no-ops, that is a finding to investigate and bring
back to the operator — the fallback of serving the engine through a splat
resource route is a meaningful downgrade, not a drop-in substitute.

### 7.3 Database

Gap 3 of the handoff rightly demanded active verification rather than "watch for
the absence of pool-timeout errors", which proves a negative. But its proposed
method — reproduce the concurrent load — is *the same activity that caused the
pool pressure*, against a database dev and production share. Running it as
verification risks re-creating the outage being fixed.

Therefore:

- **Primary evidence: Neon's connection metrics show ≤1 connection per instance.**
- Any load reproduction is secondary, tightly bounded, run once, and only *after*
  the caching half is live — edge-caching `/models/:id.glb` removes a
  `findUnique` per model load and lowers the floor first.

## 8. Corrections to the handoff

Checked against source; the handoff was wrong or incomplete on these:

| Handoff said | Actually |
|---|---|
| Add cache headers to `vercel.json` | No `vercel.json` exists — it is created at `apps/shopify-app/vercel.json` |
| Draco assets at `/tryon/draco/*` | They are at `/tryon/draco/gltf/*` |
| Confirm `directUrl` is configured | It is absent from `schema.prisma` and must be added |
| Merchant route gets `max-age=31536000, immutable` | Also needs `s-maxage`, or Vercel's edge will not cache the function response |
| Verify DB by reproducing concurrent load | That is what caused the pressure; Neon metrics are primary evidence |

Unchanged and carried forward: the 1.48 MB measurement, the scope decision, the
cut of C, and gap 2's ruling that `immutable` is unsafe on stable-named paths.

## 9. Constraints carried from prior sessions

- Dev and production **share one Neon database** — reconfirmed 2026-07-26: local
  `DATABASE_URL` resolves to endpoint `ep-solitary-breeze-as0s37zn`, the same one
  production uses. Note this holds *despite* the Neon project having a separate
  `dev` branch, which is currently unused. Test fixtures must be
  `randomUUID()`-tagged and cleaned by **exact name**, never by prefix — a pattern
  filter can match rows we did not create. A failed test skips its own cleanup, so
  track fixtures and clean in `afterAll`. **The test suite does not run against
  the production database.**
- **Follow-up candidate (out of scope here):** point local `DATABASE_URL` at the
  existing Neon `dev` branch. That would retire the constraint above entirely and
  relax the load-testing caution in §7.3, which exists only because the two
  environments currently share one database.
- **A green local build does not prove a green Vercel build.** Local has all
  packages; Vercel prunes devDependencies and resolves temp configs differently.
- **Keep `vite.config` free of application runtime imports.**
- The engine is a **committed artifact** at `apps/shopify-app/public/tryon`
  (~15 MB, trimmed). Regenerate with `npm run build:engine` from the repo root.
  **Do not** re-add a Vercel-side engine build — three deploys failed that way.

## 10. Out of scope

- **C, payload trim** — cut; the 1.48 MB measurement removed its rationale.
- **D monitoring, E device matrix, F accessibility** — later slices, each with its
  own spec → plan → build.
- Content-hashing the engine model and draco filenames. Considered and rejected:
  the gain is small because those files change only on re-export, and it would
  reintroduce the Vite-build blast radius that cutting C removed.
