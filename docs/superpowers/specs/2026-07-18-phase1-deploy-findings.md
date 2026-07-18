# Phase 1 (Deploy) — Prep Findings

**Date:** 2026-07-18
**Roadmap:** `2026-07-17-app-store-submission-roadmap.md` → Phase 1
**Status:** Prep in progress; one decision open (storage backend)

Investigation of the app before writing deployment config. Three findings materially
shape how Phase 1 is executed.

## Finding 1 — Local-disk storage is incompatible with Vercel *(blocker — ✅ RESOLVED 2026-07-18, commit 1bd01a3)*

**Resolved:** storage backend swapped to **Cloudflare R2** (S3-compatible). `saveModelGlb`
puts, new `readModelGlb` gets; the S3 client is built lazily so a missing-env import can't
take down the app at boot. `readModelGlb` returns null only for a genuinely absent object —
credential/network faults rethrow, so an outage surfaces as a 500 rather than telling every
merchant their model doesn't exist (the old route swallowed every error into a 404). No `fs`
left in `app/`. The two tests that asserted bytes on disk now stub storage with an in-memory
map. App tests 16/16, `react-router build` clean. New env vars documented in `.env.example`.

*Original analysis below.*


`apps/shopify-app/app/storage.server.js` writes calibrated GLBs to
`join(process.cwd(), 'storage')`. Its own comment says: *"dev-slice local-disk storage
only; production hosting swaps this for a CDN/object store (sub-project D)."*

Vercel's filesystem is ephemeral (only `/tmp`, per-invocation). Every uploaded and
calibrated model would disappear. **This must be swapped before a Vercel deploy can work** —
it is a Phase 1 blocker, not Phase 3 polish as originally filed.

`ModelAsset.storageRef` is a filename within that dir; `models.$assetId[.]glb.jsx` serves it
back. Both change with the storage backend.

### Options

| Option | Notes |
|---|---|
| **Vercel Blob** | Native to the chosen host, least integration friction, simple SDK. Egress billed by Vercel. |
| **Cloudflare R2** | S3-compatible, **no egress fees** — attractive for repeatedly serving ~6 MB GLBs. Extra account. |
| **Shopify Files** | Merchants already upload GLBs to Shopify Files for the theme-block path, served from Shopify's CDN. Avoids owning storage entirely — but the admin flow stores a *normalized re-export*, which still needs a home. |
| **S3** | Standard, portable, more setup. |

Recommendation: **R2 or Vercel Blob.** R2 if GLB egress volume matters (it likely will —
these are multi-MB assets fetched per try-on); Vercel Blob if minimizing moving parts wins.

## Finding 2 — React Router v7 needs a Vercel preset

`package.json` uses `react-router build` + `react-router-serve ./build/server/index.js`
(a long-running Node server). There is **no `react-router.config.js`**. Deploying to Vercel
requires adding the `@vercel/react-router` preset so the server builds as Vercel functions.

Alternative: a persistent-process host (Fly.io / Railway / Render) runs `react-router-serve`
as-is with no preset — and pairs naturally with a mounted volume, though volumes don't scale
across instances and still aren't the right answer for asset storage.

## Finding 3 — Postgres migration ends local SQLite dev

`prisma/schema.prisma` is `provider = "sqlite"`, with 3 SQLite-dialect migrations and
`migration_lock.toml` pinning the provider. Switching to `postgresql` requires regenerating
the migration history (SQL is dialect-specific).

Prisma supports **one provider per schema**, so this is not "SQLite local, Postgres prod" —
after the switch, local `shopify app dev` also needs Postgres. With Neon this is fine (use a
Neon **branch** as the dev database), but it changes the local workflow and should land when
the Neon account exists, not before — otherwise local dev breaks in the interim.

Schema is otherwise Postgres-compatible: `Json` (fitMetadata), `BigInt` (Session.userId),
`DateTime`, and `@unique` all map cleanly.

## Environment variables required

| Var | Purpose | Source |
|---|---|---|
| `SHOPIFY_API_KEY` | App client ID | Partner Dashboard |
| `SHOPIFY_API_SECRET` | App client secret | Partner Dashboard |
| `SHOPIFY_APP_URL` | Public app URL (replaces the `example.com` placeholder) | Vercel deployment URL |
| `SCOPES` | Access scopes | `shopify.app.toml` |
| `DATABASE_URL` | Postgres connection | Neon |
| `SHOP_CUSTOM_DOMAIN` | Optional custom shop domain | optional |
| *(storage creds)* | Depends on Finding 1 outcome | TBD |

`NODE_ENV`, `PORT`, `HOST`, `FRONTEND_PORT` are runtime/dev-only and host-managed.

## Execution order (once decisions are in)

1. Swap storage backend (Finding 1) — unblocks everything else.
2. Add Vercel preset + `react-router.config` (Finding 2).
3. Prisma → Postgres + regenerate migrations, pointed at Neon (Finding 3).
4. Set env vars in Vercel; deploy engine SPA + app server.
5. Replace `application_url` in `shopify.app.toml`; update Partner Dashboard redirect URLs.
6. Verify OAuth install end-to-end on a fresh dev store — with attention to the embedded
   App Bridge handshake, which was historically flaky in dev and must be solid in prod.

## Open decision

**Storage backend** (Finding 1). Blocks step 1, which blocks the rest.
