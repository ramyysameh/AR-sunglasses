# Polaris 24/24 UX Acceptance Record

**Date:** 2026-09-19
**Branch / commit checked:** `feature/admin-ux` @ `804a972`
**App root:** `apps/shopify-app`
**Node / npm:** v24.13.0 / 11.6.2
**Author of this record:** Task 7 acceptance run (automated + static evidence; no authenticated Shopify session was available — see Steps 3–6 below)

This record is the evidence backing the rescoring of `UI-REVIEW.md`. Every row below states exactly what was run or inspected, what it proved, and — where a check requires a live authenticated embedded session — precisely what could not be done and what a human needs to do to close it.

---

## Step 1 — Automated suite

All four commands were run from `apps/shopify-app`.

| Command | Result | Detail |
|---|---|---|
| `npm test` | ✅ PASS | Vitest: **46 test files, 278 tests, 0 failures**, 277.29s. |
| `npm run typecheck` | ✅ PASS (hollow — see below) | `react-router typegen && tsc --noEmit` exits 0 with no diagnostics. |
| `npm run lint` | ✅ PASS | `eslint --ignore-path .gitignore --cache .` exits 0 with no output. |
| `npm run build` | ✅ PASS | `react-router build` — Vite client build (454 modules) + SSR build (62 modules) both succeed. Only non-blocking warnings: a >500kB `model-viewer` chunk and five React Router v8 future-flag notices. |

### The typecheck gate is hollow — do not read it as type safety

Verified directly:

- `apps/shopify-app/tsconfig.json` → `"include": ["env.d.ts", "**/*.ts", "**/*.tsx", ".react-router/types/**/*"]` — no `**/*.jsx` glob, and `checkJs` is not set anywhere in `compilerOptions`.
- File count: `find app -name "*.ts" -o -name "*.tsx"` → **0** files. `find app -name "*.jsx"` → **29** files.

Every line of this app's actual UI and route code lives in `.jsx` files that `tsc --noEmit` never opens. `npm run typecheck` passing is therefore evidence the two `.ts`-shaped config surfaces (`env.d.ts`, generated route types) are consistent — it is **not** evidence that any component, prop, or handler in the app is type-correct. Task 4's review already measured the real cost of closing this gap: turning on `checkJs` + `**/*.jsx` produces **364 errors app-wide** (92 of them in that task's two files alone), roughly 73% of which are `noImplicitAny` noise from a codebase with no JSDoc typing — and it would also have to special-case the (correct) `paginate=""` boolean-attribute pattern and a `useRef(null)` narrowing false-positive. This is carried into the follow-up list below rather than fixed here, per the brief's explicit scope boundary.

---

## Step 2 — Shopify component validator

**Skill:** `shopify-plugin:shopify-polaris-app-home` (plugin `shopify-ai-toolkit@1.6.0`)
**Validator internals:** TypeScript 5.9.3, in-memory virtual language-service host, `jsxImportSource: "preact"` (bundled types at `assets/types/preact/10.29.2`, gzip-compressed), `moduleResolution: NodeJs`.

### search_docs.mjs — ran clean for every component family touched by Tasks 1–6

`s-table` / `s-table-header listSlot`, `s-banner`, `s-modal`, `s-choice-list`, `s-search-field`, `s-select`, `s-query-container`, `s-badge` — all returned valid, on-topic Shopify doc matches (e.g. `s-table` returned the Table doc with a full `listSlot`-bearing example). No search failed or returned empty.

### validate.mjs — reproducibly broken in this environment; confirmed a tooling defect, not a component-approval signal

**Control test first.** Before touching any app code, `validate.mjs` was run against a snippet copied **verbatim from Shopify's own bundled docs example** (`<s-page heading="Products"><s-section heading="All products"><s-text>Content</s-text></s-section></s-page>`):

```
❌ INVALID — s-page/s-section/s-text validation failed: Property 'unknown': JSX element
implicitly has type 'any' because no interface 'JSX.IntrinsicElements' exists.
This JSX tag requires the module path 'preact/jsx-runtime' to exist, but none could be
found. Make sure you have types for the appropriate package installed.
```

A docs-verified-valid snippet fails identically to everything else below. This is the control that proves the failure is in the validator's bootstrap, not in any code being checked.

**Investigation.** The skill directory *does* bundle Preact type stubs (`assets/types/preact/10.29.2/jsx-runtime/...`, gzip-compressed), so this is not simply "the package is missing" — a plausible reason the earlier reviewer doubted that specific attribution. The compiler is configured with `moduleResolution: NodeJs` and `jsxImportSource: "preact"` inside a custom virtual `ts.LanguageServiceHost` that serves those gzipped assets through its own `fileExists`/`readFile` implementation; the defect is somewhere in that resolution wiring, not in a missing dependency. Root-causing the exact line is out of scope for this task (the brief calls for a brief investigation, not a fix); this is recorded as a confirmed **tooling defect**.

**Every changed App Home file was still run through it**, to catch any genuine component-property error hiding behind the noise:

| File | Result | Non-bootstrap findings |
|---|---|---|
| `app/routes/app._index.jsx` | Bootstrap failure only | Also flagged `Cannot find module '@shopify/shopify-app-react-router/server'` — expected: validating one file in isolation, outside the app's real module graph. Correctly identified `SetupGuide`, `TopLevelAdminAction` as non-Shopify components (not validated, not errored). |
| `app/routes/app.products.jsx` | Bootstrap failure only | Same missing-module isolation artifacts (`@shopify/app-bridge-react`, `process`), plus `key` prop false-positives from `.map()` (the validator doesn't know React's implicit `key` isn't a real prop when checking a single file). No Polaris property error. |
| `app/routes/app.models.jsx` | Bootstrap failure only | Same `key`-prop and missing-module isolation artifacts. No Polaris property error. |
| `app/routes/app.jsx` | Bootstrap failure only | Same missing-module isolation artifacts. No Polaris property error. |
| `app/routes/app.additional.jsx` | Bootstrap failure only | No other findings. |
| `app/components/ModelFitReview.jsx` | Bootstrap failure only | No other findings. |
| `app/components/ModelPicker.jsx` | Bootstrap failure only | No other findings. |
| `app/components/ProductIndex.jsx` | Bootstrap failure only | Same `key`-prop isolation artifact. No Polaris property error. |
| `app/components/TopLevelAdminAction.jsx` | Bootstrap failure only | No other findings. |
| `app/components/PreviewPanel.jsx` | Bootstrap failure only | No other findings. |

**Conclusion:** across every changed file, the validator produced zero genuine Shopify Polaris component-property errors — only (a) the universal bootstrap defect reproduced on a docs-sourced control snippet, and (b) expected artifacts of checking one file outside its real module graph (missing sibling-module imports, a false-positive on React's implicit `key`). Per the brief, a validator bootstrap failure is recorded as a tooling defect, not as component approval — this section is evidence of "no detected property errors," not a clean bill of health from Shopify's own tool. This matches and extends the same finding recorded independently during Task 1's self-check.

---

## Step 3–6 — Authenticated visual, responsive, keyboard, and recovery QA

**Genuine attempts made, in order, before concluding these were blocked:**

1. **`.claude/launch.json` "vite-dev" config** — started it. It launched `ar-tryon-prototype@1.0.0`'s dev server (the separate AR try-on/MediaPipe engine at the repo root), not the Shopify admin app in `apps/shopify-app`. Not usable for this task; stopped.
2. **`npm run dev` (`shopify app dev`)** — not run interactively: it requires a `shopify` CLI login and opens an OAuth/tunnel flow with no way to complete authentication non-interactively in this environment, and per prior session notes in this repo this app's `shopify app dev` loads the deployed App Store release inside Shopify's in-app browser rather than the local tunnel even when it does run.
3. **Bare `vite` dev server directly against `apps/shopify-app`** (bypassing the Shopify CLI, to at least see how far a request gets): started on a free port and hit `GET /app` directly.
   - First attempt: fails immediately inside `shopifyApp()` initialization — `Detected an empty appUrl configuration` (`deriveApi` in `@shopify/shopify-app-react-router`). Confirmed `apps/shopify-app/.env` has no `SHOPIFY_APP_URL` key at all (only `SHOPIFY_API_KEY`, `SCOPES`, `DATABASE_URL`/`DIRECT_URL`, AWS keys) — that variable and `SHOPIFY_API_SECRET` are injected only by the Shopify CLI's dev tunnel session, never present in a plain `vite` run.
   - Second attempt, with `SHOPIFY_APP_URL` set by hand for the process only: fails one step later — `Cannot initialize Shopify API Library. Missing values for: apiSecretKey.` Confirmed `.env` genuinely has no `SHOPIFY_API_SECRET`.
   - Even if both were supplied, `app/routes/app.jsx`'s loader calls `authenticate.admin(request)` on every request, which requires a real Shopify session token — there is no session to present outside an actual installed-app admin iframe.
4. **Existing browser/e2e harness** — checked `apps/shopify-app/package.json` and `test/` directory: no Playwright, Cypress, Puppeteer, or any browser-driving dependency exists in this project. All 46 test files are Vitest unit/SSR-string tests (`renderToStaticMarkup`), not a rendered-DOM or real-browser harness.

**Conclusion: Steps 3–6 as written (a real authenticated embedded merchant session, real viewport rendering, real keyboard traversal, real forced network failures observed in a live browser) are not possible from this environment.** There is no credential path to an installed, authenticated Shopify store, and the app's own loaders refuse to render anything without one. This is a hosting/credential gap, not a shortcut taken — closing it requires a human with an installed development store and either a working `shopify app dev` tunnel or a deployed preview URL opened inside that store's admin.

**What was gathered instead — static evidence, clearly not a substitute for the above, but real and directly checked in this session:**

- **Icon-only controls have accessible names.** `grep -rn "s-button" ... | grep "icon="` found 8 icon-bearing `<s-button>` usages. Seven have a visible text child (`Change product`/`Select product`, `Open on this computer`, `Change model`, `Remove try-on`, `Rename`, `Delete`) so an `accessibilityLabel` is not required by Shopify's own guidance; the one genuinely icon-only button (`ProductIndex.jsx:107-112`, the row's kebab/`menu-vertical` action trigger) does carry `accessibilityLabel={`Actions for ${m.product?.title ?? 'product'}`}`. No icon-only control was found without a label.
- **No stray raw admin anchors.** `grep -rn '<a href' app/routes app/components` returns exactly three hits: `app/routes/app.jsx:55` (the deliberate no-subscription top-level recovery fallback, already documented in code comments as intentionally not `s-link`/`TopLevelAdminAction`) and two `mailto:` links in `privacy.jsx` (a static support page, not an admin-navigation destination). `grep -rn "admin.shopify.com"` across `app/routes app/components` returns nothing — every admin URL is constructed through a helper and rendered via `TopLevelAdminAction`, used consistently in `app._index.jsx`, `app.products.jsx`, `app.additional.jsx`, `ModelFitReview.jsx`, `ProductIndex.jsx`, `SetupGuide.jsx`.
- **No `onChange` survives on any `s-*` custom element.** `grep -rn "onChange=" app/routes app/components` returns exactly two hits, both in `app.products.jsx`, and both are `<ModelPicker onChange={setModelAssetId} />` — `onChange` there is this app's own component prop name, not a DOM listener on a web component. Inside `ModelPicker.jsx` and `app.models.jsx`, every listener actually bound to an `s-*` element uses `onInput` (`s-search-field`, `s-choice-list`, `s-drop-zone`, `s-text-field`), each with an inline comment citing the React 18 `ChangeEventPlugin` gap that made the old `onChange` bindings silently inert. **Result: zero un-migrated `onChange`-on-`s-*` risk remains** — Tasks 5 and 6 fully closed the pre-existing prod bug flagged during Task 4's review.
- **Four merchant states yield a completable, contextual primary action — checked by SSR-rendering the real routes with each loader shape**, exactly as the brief suggested, not just by calling the helpers in isolation:
  - `test/appIndex.ui.test.js` — `buildSetupSteps`/`nextSetupAction` table-tested for all four states: `{model:0,mapping:0,live:0}` → "Upload model" → `/app/models`; `{1,0,0}` → "Add try-on" → `/app/products`; `{1,1,0}` → "Add to theme" → theme URL; `{1,1,1}` → "Manage products" → `/app/products`. Separately, `SetupGuide` rendering tests assert every incomplete step is actionable and completed steps show "Done" while the theme action stays reachable.
  - `test/appProducts.ui.test.js` — `renderToStaticMarkup(React.createElement(Products))` run three times with distinct `loaderData` shapes: zero-model (asserts "Upload model" primary action, and — critically — asserts the `add-tryon` modal is **absent from the tree entirely**, not just hidden, closing the P1 dead-end bug from the original review), models-exist-but-unmapped (asserts the real "Add try-on to your first product" empty state with a reachable modal), and at-limit (asserts "Upgrade plan" replaces "Add try-on"). `productPrimaryAction` is additionally table-tested for `{assetCount:0}` → upload, `{assetCount:2, atLimit:false}` → add, `{assetCount:2, atLimit:true}` → upgrade.
  - `test/appModels.ui.test.js` — same SSR pattern renders `Models` with real loader shapes, asserting the library is the primary surface, modal targets are valid, and every review-required model gets a "Review fit" action against one shared modal (not one per card).
- **Mobile list slots are present and correctly assigned.** `app/components/ProductIndex.jsx:224-226` — `<s-table-header listSlot="primary">Product</s-table-header>`, `listSlot="labeled"` on Model, `listSlot="secondary"` on Status — exactly the primary/secondary/labeled assignment the brief's Step 4 specifies.
- **The responsive filters grid has its container.** `app/components/ProductIndex.jsx:184` wraps the filter controls in `<s-query-container slot="filters">...</s-query-container>`, closed at line 222 — the ancestor the brief's Step 4 responsive check depends on (and the specific gap a Task 4 review round previously caught and fixed).
- **Compact model picker mounts exactly one interactive preview.** `test/appModels.ui.test.js:251` — "renders a search field and mounts exactly one preview, for the selected asset only" — and `test/appProducts.ui.test.js` uses the `ModelViewer` loading-spinner `accessibilityLabel` as a per-instance marker to assert exactly one mounts regardless of library size.
- **Error banners identify what failed and expose a working retry; success toasts are supplementary, not the only signal.** `grep` across `app.products.jsx`/`app.models.jsx` shows six distinct critical banners, each with a specific heading naming the failed action ("Could not change model", "Could not remove try-on", "Could not add try-on", "Could not upload model", "Could not rename model", "Could not delete model"), each paired with a "Try again" button when the fetcher result is retryable (`retryMatches` helper). `test/appProducts.unmap.test.js` — "keeps the mapping when storefront unpublishing fails so removal can be retried" — is a real forced-failure test asserting the merchant's existing mapping row survives a failed unpublish rather than disappearing. Success paths (`shopify.toast.show('Model changed')`, etc.) fire only alongside a fetcher success branch that is mutually exclusive with the error-banner branch and independently drives a revalidated page state (the row/list re-renders from updated loader data), so completion is legible from the page even if a toast is missed — but this was verified by reading the control flow, not by watching a live toast render and disappear.

None of the bullets above are a substitute for Steps 3–6's actual live-session requirements (real pixel layout at 320/768px, real focus-trap and Tab/Shift+Tab/Escape behavior, real `model-viewer` keyboard behavior, a real forced-failure banner observed rendering in a live DOM). They are the concrete, checkable ceiling reachable without an authenticated store, offered as evidence for the rows below where they genuinely close the gap, and explicitly not claimed where they don't.

---

## Result table

| Gate | Result | Evidence |
|---|---|---|
| Shopify-native visual system | PASS | Every changed App Home file run through Shopify's validator — zero genuine component-property errors (only the confirmed bootstrap defect, reproduced on a docs-sourced control, plus expected single-file isolation artifacts). Consistent native `s-*` usage; admin navigation centralized in one `TopLevelAdminAction` component used across 6 files; zero stray raw `<a href>` to `admin.shopify.com` outside the one documented, intentional no-subscription fallback. `npm run build`/`lint` clean. |
| Information hierarchy | PASS | `test/appIndex.ui.test.js` SSR-renders the Home route and table-tests `buildSetupSteps`/`nextSetupAction` against exactly the four setup states (fresh install → model ready → product configured → complete), each asserting the correct contextual primary action and destination. |
| Merchant journey and task clarity | PASS | `test/appProducts.ui.test.js` SSR-renders `Products` with zero-model, unmapped, and at-limit loader shapes; asserts the original P1 "empty-model dead end" bug is closed (the `add-tryon` modal is absent from the tree, not just visually hidden, when no model exists) and that `productPrimaryAction` picks upload/add/upgrade correctly. `test/appModels.ui.test.js` confirms the Models route surfaces one shared "Review fit" remediation path per asset. |
| Interaction and feedback | PASS (partial) | Six distinct critical banners (one per failure type, each naming the failure) each pair with a conditional "Try again" action via a shared `retryMatches` helper. Of the three failure paths Step 6 requires (upload, mapping, unmapping), only **unmapping** has a genuine forced-failure test with a preserved-work assertion: `test/appProducts.unmap.test.js:66`, "keeps the mapping when storefront unpublishing fails so removal can be retried." The **upload** and **mapping** banners ("Could not upload model", "Could not add try-on") are grep-verified present in the JSX with correct headings and retry wiring, but neither is exercised by a forced-failure test: `finalizeUpload.server.test.js` forces failures only at the pure-function level (`rejects.toThrow`) without asserting the banner or a retry action renders from it, and no test anywhere references `mapError` or the "Could not add try-on" banner under a forced condition — `appProducts.map.test.js` covers validation errors (cross-shop asset, plan cap) only, not a forced mapping-publish failure. Success toasts fire on a branch mutually exclusive with the error banner and are backed by revalidated page state, not the only completion signal. **Marked PASS (partial): real, working evidence for 1 of 3 required failure paths plus correct-by-inspection markup for the other 2 — not a full Step 6 pass.** |
| Responsive behavior and scale | BLOCKED | No authenticated embedded session was reachable (see investigation above: `shopify app dev` needs interactive CLI auth; a bare `vite` server fails before rendering anything because `SHOPIFY_APP_URL`/`SHOPIFY_API_SECRET` only exist inside a CLI tunnel session; no Playwright/Cypress harness exists in the repo). Structural prerequisites are in place and unit-tested — `listSlot="primary"/"labeled"/"secondary"` on the Products table headers, `<s-query-container slot="filters">` wrapping the filter grid, exactly one mounted `ModelViewer` in the compact picker — but "no horizontal scroll," "filters operable without overlap," and "modal actions remain visible" at 320/768/desktop are rendering facts that were not, and could not be, observed. **Human steps to close:** open the deployed admin (or a working `shopify app dev` tunnel) inside an installed development store, resize to 320px/768px/desktop, and check the six bullet points in Step 4 of the task brief directly. |
| Accessibility and inclusive UX | BLOCKED | Same authentication gap as above. Static evidence is real but partial: every icon-only control has an `accessibilityLabel` (grep-verified, 8 icon-bearing buttons checked), and the pre-existing `onChange`-on-`s-*` dispatch bug is fully closed (grep-verified zero remaining instances). But keyboard Tab/Shift+Tab/Enter/Space/Escape traversal, modal-close focus return, menu/icon-button accessible-name announcement in a real assistive-tech tree, and the absence of a keyboard trap inside `model-viewer`'s shadow DOM are runtime facts that cannot be established from source alone. **Human steps to close:** in an authenticated embedded session, keyboard-only traverse the setup guide, Products search/filter/sort/pagination, and every modal listed in Step 5 of the task brief, verifying focus return and no trap in `model-viewer`. |

*Legend: the task brief's Step 7 table specifies a `PASS/FAIL` Result column. This record uses `PASS`, `PASS (partial)`, and `BLOCKED` instead. `BLOCKED` was introduced to distinguish "not testable in this environment" (no authenticated Shopify session was reachable — see the investigation above) from "tested and failed" — reporting an untested row as a bare `FAIL` would itself be a form of overclaiming, since it implies a test ran and found a defect. `PASS (partial)` marks a row where real, working evidence exists but does not cover every requirement in the brief's corresponding step. For scoring purposes, `BLOCKED` rows are held below a full 4/4 in `UI-REVIEW.md`'s pillar table (they carry no live-verified evidence at all). `PASS (partial)` does not by itself force a score reduction — its pillar (Interaction and feedback) keeps 4/4 because the underlying mechanism (per-failure banners, shared retry helper, one genuine forced-failure precedent) is real and correct; the gap is that 2 of 3 required failure paths lack a forced-failure *test*, which is recorded as a named follow-up task rather than a score penalty. Either way, no row marked anything other than an unqualified `PASS` is treated as fully closing its brief step.*

**Because two of the six rows are BLOCKED and one is only a partial PASS, `UI-REVIEW.md` is not rescored to 24/24.** See `UI-REVIEW.md` for the rescored pillar table and the follow-up task list this record feeds.
