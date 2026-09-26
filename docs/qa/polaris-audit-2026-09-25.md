# Admin UI/UX audit against Polaris — 2026-09-25

**Scope:** the embedded Shopify admin in `apps/shopify-app/app` as it stands on this branch (Workspace `/app`, Models `/app/models`, Help `/app/additional`, the no-plan welcome screen in `app.jsx`, and every modal/flow they mount).
**Method:** source-level review against Polaris principles (App Home web components, action hierarchy, content guidelines, badge/tone semantics, empty states, accessibility). No authenticated Shopify session was available, so nothing here was observed live; findings are from the rendered component structure.

> **Why a new audit:** `UI-REVIEW.md` (21/24) describes the pre-redesign app. It cites `ProductIndex.jsx` and a standalone Products page, but `app.products.jsx` now just redirects to `/app` and the Workspace redesign replaced that UI. Its score doesn't apply to the current code.

## Fix status

**Fixed on this branch:**
- **Pass 1:** #1, #2, #3, #4, #6, #7, #9, #10, #13, #18.
- **Pass 2:**
  - **#5 (partly):** the product table and plan meter are now `s-section` cards, and the doubled guide border and hand-drawn panel CSS are gone.
  - **#8:** Add try-on and Change model both use `ModelPicker` and offer only ready models, plus the current model when changing.
  - **#11 (Delete half):** in-use model cards say why there's no Delete.
  - **#12:** "Step N of 3", one heading per step, Cancel instead of Close, and Continue after picking a model.
  - **#14:** `rel="home"`, confirmed in `@shopify/app-bridge-types`.
  - **#15:** ready model cards get **Add try-on** (`/app?add=1&model=…`), and "View products" opens the Workspace searched for that model (`/app?q=…`).
  - **#19:** Review fit moved into the card's action row.
- **Pass 3:**
  - **#5 (rest):** search and status now sit in `s-table`'s `filters` slot as an `s-search-field` and a labelled `s-select`, with counts in the option labels. The custom `<button>` cards, their hard-coded colors, and the workspace's hand-written focus rings are gone. The audit suggested "a button group or choice chips", but neither fits: App Home has no tabs and no pressed-button state, `s-clickable-chip` can't announce which chip is selected, and `s-choice-list` doesn't expose its inline variant here. `s-select` is the accessible single choice. When a search matches nothing, the filter bar stays above the "No products match" message so the search can be undone.

**Deliberately left:**
- **#11 (Add try-on half):** it stays disabled at the plan limit. The plan meter directly below says "Upgrade to add more products" and has an Upgrade button, and adding a fourth route to pricing would undo an earlier deliberate cleanup.
- **#16:** the unreachable `plan-limit` status is kept. It has explicit defensive tests.
- **#17:** the native upload `<progress>` is kept. There's no Polaris web-component equivalent.

**Pass 4, mark as reviewed:** both review dialogs (Workspace and Models) have a primary **Mark as reviewed** action. It sets a new `ModelAsset.fitReviewedAt` (migration `20260926000000_model_fit_reviewed`), and `needsFitReview` stops flagging a reviewed model. That clears "Needs fit review" on every product using the model, and lets the model appear in the Add try-on and Change model pickers. The action is shop-scoped. The storefront is unaffected, because `getTryonConfig` serves a mapped model whatever its status.

**Still needs a live, authenticated admin session:** layout checks at 320px, 768px, and desktop width; keyboard-only testing of the guide, table, filters, row menus, and every modal (including focus return); and confirming that in-app `s-button href` navigation and the review-fit → change-model handoff work in App Bridge.

## Rescore — 2026-09-26

Source-level, after passes 1–4. There was still no authenticated admin session, and this environment's network policy blocks `cdn.shopify.com`, so the Polaris runtime couldn't be loaded to render pages in a browser either.

| Pillar | Baseline | Now | Why |
|---|---:|---:|---|
| Shopify-native visual system | 2 | 4 | Every surface is a Polaris component (sections, table, filter bar, select, search). The only custom CSS left is the plan meter, which has no Polaris equivalent. |
| Information hierarchy | 2 | 4 | One primary action per page. Row actions are secondary, badges name states, and no action repeats within a row. |
| Merchant journey & task clarity | 2 | 4 | No dead ends or unreachable pages. Recovery actions match the problem, plan-limit paths lead to Upgrade, and "Needs fit review" can now be resolved. |
| Interaction & feedback | 3 | 4 | Errors are in merchant language and every banner has a heading. Failures keep the merchant's work and offer a retry, and Add try-on has explicit steps. |
| Responsive behavior | 3 | 3 | Structurally sound: `listSlot`, auto-fit grid, table filters slot. Not observed at 320px, 768px, or desktop width. |
| Accessibility | 3 | 3 | Labelled fields, no custom controls, Polaris-drawn focus. Keyboard-only use and focus return haven't been observed. |
| **Total** | **15** | **22** | |

The last two points need observation, not code: the live checks below. No known defect holds either pillar down.

## Scorecard (baseline, 2026-09-25)

| Pillar | Score | One-line reason |
|---|---:|---|
| Shopify-native visual system | 2/4 | Hand-built filter cards and panels with hard-coded hex colors sit next to Polaris components; the main column uses no `s-section`. |
| Information hierarchy | 2/4 | Every table row has a `variant="primary"` button, on top of the guide's primary and the page's primary action. |
| Merchant journey & task clarity | 2/4 | One dead end (upload), one orphaned page (Help), and a recovery action that points to the wrong fix. |
| Interaction & feedback | 3/4 | Toasts, confirmation modals, and retry states are all good. Upload errors are shown to merchants in developer wording. |
| Responsive behavior | 3/4 | `listSlot`, auto-fit grid, and a scrolling filter row look right. Not verified live. |
| Accessibility | 3/4 | `accessibilityLabel` coverage, `aria-pressed`, and focus return are solid. The custom controls re-create focus styles by hand. |
| **Total** | **15/24** | Functional and recognizably Shopify. Needs one refinement pass, mostly on hierarchy and consistency. |

## What's already right (keep it)

- The app uses App Home web components (`s-page`, `s-table`, `s-modal`, `s-badge`, `s-menu`) consistently. There's no mixed Polaris React/web-component usage.
- Destructive actions (Remove try-on, Delete model) go through a confirmation modal with `tone="critical"` and copy that says what will happen.
- Success is reported with a toast, and failure with an inline critical banner that keeps the merchant's work and offers **Try again**.
- Focus goes back to the Add try-on trigger after the modal closes (`app._index.jsx:42-57`).
- 3D previews load lazily with an accessible spinner (`ModelViewer.jsx`).
- Admin destinations (theme editor, pricing) all go through `TopLevelAdminAction`, so none of them fails silently.

---

## P1: fix first (misleading or blocking)

### 1. A model that only needs a fit review is shown as a critical "Model issue", and the suggested fix is the wrong one
- `productStatus` returns `check_fit`, labelled **"Review fit"** in warning tone (`tryonStatus.server.js:52-54`).
- `normalizeWorkspaceStatus` folds it into `model-issue` (`workspace.server.js:17-22`), which renders as **"Model issue"** in *critical* tone (`ProductOperationsList.jsx:8`).
- The guide then says "A model needs attention" with the action **Choose model** (`workspace.server.js:50-57`). That opens *Change model*, not the fit review.
- The same asset shows as "Review fit" (warning) on the Models page (`app.models.jsx:397-399`), and Help tells merchants to look for "Review fit".

**Polaris principle:** a badge tone has to match how serious the state is (critical means broken or blocking), and one concept should keep one name across the app.
**Fix:** carry `check_fit` through as its own workspace status: label "Review fit", tone `warning`, primary action **Review fit** opening `ModelFitReview`. Use "Model issue" only for a genuinely failed asset.

### 2. Dead end: the app points merchants to an upload that doesn't exist
- `ModelPicker` says "Upload a model on the **Models** page first" (`ModelPicker.jsx:92-97`).
- The Models page has no upload action and no page primary action (`app.models.jsx:357`). Its empty state is a plain link back to `/app` (`:359-366`).
- Upload only exists inside the Add try-on flow, so a merchant can't build a model library ahead of time.

**Fix:** give Models a page `primary-action` of **Upload model** (the non-embedded `ModelUploadFlow` already supports `triggerSlot="primary-action"`). Change the empty state to that button. Point ModelPicker's copy at it.

### 3. The Help page can't be reached
`/app/additional` isn't in `s-app-nav` (`app.jsx:97-100`), and nothing links to it. The Workspace "Support" aside (`app._index.jsx:301-304`) only links to privacy and email.
**Fix:** add `<s-link href="/app/additional">Help</s-link>` to the nav, and link it from the Workspace aside.

### 4. Too many primary buttons
Each row renders its action as `variant="primary"` (`ProductOperationsList.jsx:85, 93, 107`). The guide adds another primary (`WorkspaceGuide.jsx:45, 52`), and the page adds its primary action (`app._index.jsx:255`). With 20 products that's more than 20 primary buttons on one screen.
**Polaris principle:** one primary action per page or card. Row actions in an index table are secondary or tertiary.
**Fix:** make row actions `variant="secondary"` (or `tertiary`). Leave primary emphasis to the page action and the guide.

---

## P2: consistency and Polaris-native structure

### 5. Custom-built UI where Polaris components exist
- The status filters are raw `<button>` "cards" with hand-written hover and focus styles and hard-coded colors (`#005bd3`, `#c9cccf`, `#202223`) (`WorkspaceFilters.jsx:18-35`, `workspace.css:21-56`).
- The main column is `div.workspace-shell` with custom bordered `<section>` panels (`#dedede`, `#fff`) instead of `s-section` cards (`app._index.jsx:267-291`, `workspace.css:1-19`).
- `WorkspaceGuide` sets both `border="base"` on `s-box` *and* a CSS border through `.workspace-guide-panel` (`WorkspaceGuide.jsx:19-24`, `workspace.css:8-13`), which will probably draw a double border.

**Fix:** put the table in `<s-section padding="none">` and move search and status filters into `s-table`'s `filters` slot (`s-search-field` plus a button group or choice chips). Wrap PlanUsage and the guide in `s-section`/`s-box` with no custom border. The plan meter can stay custom, because there's no web-component progress bar, but it's the only piece that needs its own CSS.

### 6. The most important action on the welcome screen is a text link
**Choose a plan** is an inline `<a>` inside a paragraph (`app.jsx:72-78`). The reason for using a primitive anchor is sound (it survives App Bridge misbehaving), but the only thing to do on that screen currently looks like body text.
**Fix:** render a primary `s-button` with `onClick={() => window.open(pricingUrl, '_top')}` (this is what `TopLevelAdminAction` already does), and keep the raw `<a>` as a small fallback link underneath.

### 7. Upload errors are written for developers
Merchants can see these strings: `Upload failed (network/CORS)`, `Upload failed (403)`, `Server error (HTTP 500)`, and `Uploaded model response is missing an asset id.` (`ModelUploadFlow.jsx:17, 92, 204, 208`).
**Polaris content rule:** say what happened and what to do next, in plain language.
**Fix:** map each one to a merchant-facing message, for example "The upload didn't finish. Check your connection and try again." Log the technical detail to the console.

### 8. Two different ways to pick a model
- **Add try-on** renders a full 3D viewer and a "Use X" button for *every* ready model (`AddTryOnFlow.jsx:91-101`). That won't scale, and it goes against the one-preview rule `ModelPicker` was built for.
- **Change model** uses `ModelPicker` (search, choice list, one preview). It also passes *all* assets, including ones that need review (`app._index.jsx:143`), while Add try-on filters to ready ones only.

**Fix:** use `ModelPicker` in both flows, with the same readiness filtering, and show a status badge on models that need review.

### 9. Status badges repeat the action instead of describing the state
The Status column shows a badge reading **"Add to theme"**, and the Actions column shows a button with the same text (`ProductOperationsList.jsx:7, 36`). The server already produces the right state label, "Not on your theme yet" (`tryonStatus.server.js:62`), but it gets thrown away.
**Fix:** badges describe state (for example "Not on theme") and buttons describe actions ("Add to theme").

### 10. Row actions are duplicated or missing
- The overflow menu repeats the visible primary action: Preview on live rows, and Change model on model-issue rows (`ProductOperationsList.jsx:185-186`).
- The row the guide is pointing at has its primary action removed (`:151-153`), so it looks different from every other row.

**Fix:** leave the visible action out of the overflow menu, and keep row actions stable no matter what the guide is showing.

### 11. Controls are disabled or hidden without saying why
- At the plan limit, **Add try-on** is just disabled (`app._index.jsx:261`).
- **Delete** disappears from a model card once the model is used by any product (`app.models.jsx:428`).

Polaris advises against unexplained disabled or missing actions.
**Fix:** keep Add try-on enabled and open an upgrade prompt at the limit (or add helper text next to it). On in-use models, show "Remove it from N products to delete" in place of the missing button.

### 12. Add try-on flow structure
- There's no step indicator for Model → Product → Review.
- The modal heading "Set up try-on" plus an inner heading "Review try-on" gives two stacked headings (`AddTryOnFlow.jsx:230-255`).
- The dismiss button says "Close" where Polaris uses "Cancel" for leaving a half-finished task (`:266`).

**Fix:** use step-aware headings ("Step 2 of 3: Choose a product"), one heading per step, and "Cancel".

---

## P3: polish

13. **Pluralization:** the guide can say "1 products are ready" (`workspace.server.js:79`).
14. **Nav home link:** `/app` appears as a nav item labelled "Workspace" (`app.jsx:98`). App Bridge's `s-app-nav` convention marks the home link with `rel="home"` so it isn't repeated as a menu item. Check this against the current App Bridge docs.
15. **Deep links:**
    - "View products" on a model card goes to the unfiltered Workspace (`app.models.jsx:416`).
    - The Workspace already supports `/app?add=1&model=<id>` (`app._index.jsx:32-40`), but nothing links to it.
    - Model cards could offer **Add try-on** using that link, and "View products" could pre-fill the search.
16. **Dead state:** `plan-limit` can never be produced by `normalizeWorkspaceStatus`, but `STATUS_DETAILS` and `primaryActionFor` still handle it (`ProductOperationsList.jsx:9, 39-45`).
17. **Unstyled progress bar:** the upload uses a native `<progress>` (`ModelUploadFlow.jsx:268`). Match it to the plan meter, or use `s-spinner` with the percentage.
18. **Banners without headings:** the error banners in Change model and Remove try-on have no `heading` (`app._index.jsx:144, 178`), while every other error banner in the app does.
19. **Crowded model card header:** the heading, badge, and **Review fit** button share one inline row (`app.models.jsx:387-411`) and will wrap awkwardly in 260px cards. Move Review fit into the action row next to Rename.

## Suggested order of work

1. Status taxonomy (#1, #9, #16). This touches `workspace.server.js`, `ProductOperationsList.jsx`, and their tests.
2. Upload entry on Models, plus Help in the nav (#2, #3). Small changes that remove the dead ends.
3. Action hierarchy (#4, #10, #11).
4. Polaris-native structure: `s-section` + table filters slot, and delete most of `workspace.css` (#5).
5. Content pass: error strings, headings, plurals (#7, #12, #13, #18).
6. Unify the model picker (#8).

Items 1 to 3 would plausibly bring hierarchy and journey to 3–4/4. Item 4 does the same for the visual system. The responsive and accessibility pillars still need a live check at 320px, 768px, and desktop width, plus keyboard-only testing in an authenticated admin session.
