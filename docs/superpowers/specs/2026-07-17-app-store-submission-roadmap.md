# Path to Shopify App Store Submission — Roadmap

**Date:** 2026-07-17
**Status:** Draft for approval
**Goal:** Take the AR try-on app from working dev prototype to *accepted* Shopify App Store submission.

## Honest current state

The **try-on engine** is strong and device-validated. The **Shopify app wrapping it** is a
dev-stage prototype (sub-project B Slice 1): the full install→try-on loop works on a dev
store, but nothing is deployed, hardened, or compliant. This maps onto the original
roadmap's **sub-project D** (Compliance, hardening & App Store launch) plus the deployment
foundation that was planned as "Phase 1" but never done.

**What exists:** OAuth scaffold (React Router v7), Prisma models, admin upload/mapping UI,
theme extension "Try on" button, engine served from the app, `app.uninstalled` +
`app.scopes_update` webhooks.

**What does not:** any deployment (`application_url = example.com`), production DB (SQLite),
GDPR webhooks, endpoint hardening, listing, privacy policy, billing.

## Scope decisions (resolved 2026-07-17)

1. **Distribution model → Public App Store listing.** Full Shopify review + Built-for-Shopify
   bar apply. This whole roadmap is in scope.
2. **Billing → Paid at launch (Shopify Billing API).** Phase 5 is **required**, not optional.
3. **Hosting → Vercel + Neon Postgres.** Engine (Vite SPA) and app server (React Router v7)
   both on Vercel; Postgres on Neon (serverless).

## The submission bar (what "accepted" requires)

Non-negotiable for public review: deployed always-on HTTPS app; OAuth install/uninstall
clean; the **three GDPR compliance webhooks** (`customers/data_request`, `customers/redact`,
`shop/redact`) responding correctly; HMAC-verified webhooks; a public privacy policy;
minimal justified scopes; no obvious security holes; reasonable performance; a complete
listing (name, description, screenshots, category, support contact).

---

## Phases (dependency-ordered)

### Phase 0 — Consolidate & back up  *(mine · ~small)*
Nothing is backed up remotely: `main` is 29 commits unpushed and `feat/lens-reflections`
is unmerged. Before building on it: finish/merge the reflections branch, decide the
gscale/model changes, push `main`. Clean tree, everything on the remote.
**Exit:** remote `main` current; working tree clean.

### Phase 1 — Deploy to production  *(mine to build, you to connect accounts · foundational)*
The blocker everything else depends on — until the app runs at a real URL, nothing below
can be tested in the environment reviewers see.
- Engine (Vite SPA) → Vercel, stable HTTPS URL for the iframe.
- App server (React Router v7) → hosting with a persistent runtime + webhooks.
- **SQLite → Postgres** (Prisma provider swap + migrate); connection via env.
- Real `application_url` + redirect URLs in Partner Dashboard; verify OAuth install on a
  fresh store end-to-end (the embedded App Bridge handshake was flaky in dev — must be
  solid in prod).
**You:** create hosting + Postgres accounts, hold deploy creds, Partner Dashboard config.
**Exit:** a merchant can install from a real URL and reach the try-on, in production.

### Phase 2 — Compliance  *(mine · ~small–medium)*
- The three GDPR webhooks, each responding correctly and HMAC-verified.
- Privacy policy page + camera-data disclosure (client-side processing is a strong story —
  the camera never leaves the device).
- Verify `app.uninstalled` actually purges shop data.
**Exit:** all mandatory webhooks pass Shopify's automated compliance check.

### Phase 3 — Security hardening  *(mine · ~medium — the deferred sub-project D work)*
- `register-model`: SSRF host-allowlist (Shopify CDN only), size cap, rate-limit, auth or
  signed access, bounded persistence/eviction, fix the TOCTOU orphan/422 race.
- Webhook HMAC verification everywhere; per-shop data isolation review.
- Scope minimization: justify or drop `write_products` / `write_metaobjects` /
  `write_metaobject_definitions` (over-broad scopes get flagged).
**Exit:** no unauthenticated arbitrary-fetch or cross-shop-leak surface; scopes justified.

### Phase 4 — Performance, reliability & UX  *(mine · ~medium)*
- Fix the gripzpelmo load stall: Draco mesh + texture compression + stop cache-busting the
  model every load (already scoped as the "next task").
- Error monitoring + structured logs; device/browser support matrix; accessibility pass on
  the admin (Polaris) and the try-on entry.
**Exit:** first-load under a set budget on mid-tier mobile; errors observable.

### Phase 5 — Billing  *(mine to build, you to set pricing · required)*
Shopify Billing API: recurring subscription + tiers, gated behind managed billing. Runs in
parallel with 2–4; must be green before Phase 6.
**You:** decide tiers + pricing. **Exit:** a test subscription charges and gates access.

### Phase 6 — Listing & submit  *(you decide/approve, I prep · ~small–medium)*
- Listing copy, screenshots/video, category, pricing display, support docs/contact.
- Built-for-Shopify criteria pass; final review checklist.
- **You submit** in the Partner Dashboard.
**Exit:** submission accepted (or actionable review feedback to iterate on).

---

## Critical path & parallelism

```
Phase 0 → Phase 1  ──┬── Phase 2 (compliance) ──┐
                     ├── Phase 3 (security)    ──┼── Phase 6 (listing → SUBMIT)
                     └── Phase 4 (perf/UX)     ──┘
                          Phase 5 (billing) — optional, parallel to 2–4
```

Phases 0 and 1 are strictly sequential prerequisites. 2, 3, 4 can run in parallel once
deployed. 5 is optional. 6 is last and needs 1–4 green.

## Mine vs. yours

- **I can fully own (code):** webhooks, endpoint hardening, DB migration, perf, monitoring,
  scope cleanup, listing-asset prep.
- **Needs you (accounts/ops/decisions):** hosting + Postgres accounts and deploy creds,
  Partner Dashboard config, privacy-policy hosting, billing model + pricing, listing copy
  and screenshot approval, and the actual submission click.

## Execution model

Each phase gets its own spec → plan → build cycle (like the reflections work) when we reach
it — this roadmap is the sequencing layer above those, not a substitute for them.

## Remaining inputs needed from you (as each phase starts)

- **Phase 1:** Vercel + Neon accounts and deploy credentials; Partner Dashboard access.
- **Phase 2:** where the privacy policy will be hosted.
- **Phase 5:** subscription tiers + pricing.
- **Phase 6:** listing copy, screenshots/video approval, support contact; the submission click.

All three top-level scope decisions (distribution, billing, hosting) are resolved above.
