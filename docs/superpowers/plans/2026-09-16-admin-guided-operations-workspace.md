# Admin Guided Operations Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate Home and Products experiences with one Shopify-native workspace that guides first-run setup, supports fast daily product operations, and begins every add flow with model upload or selection.

**Architecture:** Extract the existing upload and product-mutation behavior into shared modules before changing routes. Build `/app` from a focused server data contract and small UI components, then retire `/app/products` to an authenticated redirect only after all mapping actions are available from Workspace.

**Tech Stack:** React 18, React Router 7, Shopify App Bridge and Polaris web components, Prisma, Vitest, Vite.

**Spec:** `docs/superpowers/specs/2026-09-16-admin-guided-operations-workspace-design.md`

## Global Constraints

- The primary add flow order is exactly: upload or select model, choose product, review and publish.
- `/app` is the default operational workspace; `/app/products` must preserve authenticated embedded-app context while redirecting to `/app`.
- Show one obvious primary action per context; guidance is visible only while work remains or recovery is required.
- Merchant statuses are exactly `Live`, `Add to theme`, `Model issue`, and `Plan limit`.
- Keep existing mapping publication, billing limits, model processing, preview URLs, and product-specific theme-editor deep links intact.
- Recoverable failures preserve model and product selections and expose one retry action beside the failure.
- Use Shopify Admin visual conventions: neutral surfaces, restrained borders, black primary actions, semantic status colors, 6px maximum radii, and 16px to 24px spacing.
- Do not add marketing heroes, gradients, decorative illustrations, nested cards, technical error language, or a Settings destination.
- Every interaction must remain keyboard usable; icon-only controls require accessible labels and tooltips; status cannot rely on color alone.
- On narrow screens, product rows stack without dropping information or changing action order.
- Do not add a new dependency unless an existing Shopify or React API cannot provide the behavior.

## File Map

- Create `apps/shopify-app/app/components/ModelUploadFlow.jsx`: reusable model upload UI and upload session state.
- Create `apps/shopify-app/app/components/AddTryOnFlow.jsx`: three-step add flow and reducer.
- Create `apps/shopify-app/app/components/WorkspaceGuide.jsx`: first-run and recovery guidance.
- Create `apps/shopify-app/app/components/WorkspaceFilters.jsx`: summary filters, tabs, and search.
- Create `apps/shopify-app/app/components/ProductOperationsList.jsx`: responsive product operations rows.
- Create `apps/shopify-app/app/workspace.server.js`: Workspace loader aggregation and guide/status derivation.
- Create `apps/shopify-app/app/productActions.server.js`: shared map, change-model, and remove actions.
- Create `apps/shopify-app/app/styles/workspace.css`: responsive operational layout and focus styling.
- Modify `apps/shopify-app/app/routes/app._index.jsx`: unified Workspace loader, action, and page composition.
- Modify `apps/shopify-app/app/routes/app.products.jsx`: authenticated legacy redirect.
- Modify `apps/shopify-app/app/routes/app.models.jsx`: consume shared upload flow and hand off to Workspace.
- Modify `apps/shopify-app/app/routes/app.jsx`: simplify navigation to Workspace and Models.
- Create focused Vitest files named in each task and update affected route tests.

---

### Task 1: Extract The Reusable Model Upload Flow

**Files:**
- Create: `apps/shopify-app/app/components/ModelUploadFlow.jsx`
- Modify: `apps/shopify-app/app/routes/app.models.jsx:82-365`
- Create: `apps/shopify-app/test/modelUploadFlow.ui.test.js`
- Modify: `apps/shopify-app/test/appModels.ui.test.js`

**Interfaces:**
- Produces: `ModelUploadFlow({ onUploaded, triggerLabel = "Upload model", embedded = false })`.
- Produces: `uploadValidationError(file)`, `uploadModalReducer(state, action)`, `uploadModalHideBehavior(busy)`, and `createUploadCancellationCoordinator()` from the new component module.
- `onUploaded(asset)` receives the finalized model asset returned by `/app/api/model-upload/finalize`; the caller owns navigation or model selection.

- [ ] **Step 1: Write failing extraction and callback tests**

```js
// test/modelUploadFlow.ui.test.js
import { describe, expect, it, vi } from "vitest";
import {
  uploadModalReducer,
  uploadValidationError,
} from "../app/components/ModelUploadFlow.jsx";

describe("ModelUploadFlow", () => {
  it("rejects files other than GLB without clearing a previous valid selection", () => {
    const selected = new File(["glb"], "frame.glb", { type: "model/gltf-binary" });
    const state = { pendingFile: selected, uploadError: null };
    expect(uploadModalReducer(state, { type: "reject" })).toEqual({
      pendingFile: selected,
      uploadError: "Choose a .glb file up to 25 MB.",
    });
    expect(uploadValidationError(new File(["x"], "frame.obj"))).toBe(
      "Choose a .glb file up to 25 MB.",
    );
  });

  it("records the finalized asset before the owner callback runs", () => {
    const onUploaded = vi.fn();
    const asset = { id: "asset-1", status: "READY", originalFilename: "frame.glb" };
    onUploaded(asset);
    expect(onUploaded).toHaveBeenCalledWith(asset);
  });
});
```

- [ ] **Step 2: Run the focused tests and verify the new module is missing**

Run: `cd apps/shopify-app && npm test -- modelUploadFlow.ui.test.js appModels.ui.test.js`

Expected: FAIL because `app/components/ModelUploadFlow.jsx` does not exist.

- [ ] **Step 3: Move the existing upload implementation without changing its network protocol**

Create `ModelUploadFlow.jsx` by moving the constants, reducer, cancellation coordinator, `postUploadJson`, and upload content from `app.models.jsx`. Add the callback after finalize succeeds:

```jsx
const { uploaded: asset } = await postUploadJson(finalizeForm, signal);
if (!signal.aborted) {
  onUploaded?.(asset);
  shopify.toast.show("Model uploaded");
}
```

Keep the existing presign, XHR upload progress, cancellation, validation, and finalize endpoints byte-for-byte equivalent. Render a button and modal when `embedded === false`; render only the step content when `embedded === true`.

- [ ] **Step 4: Replace the inline Models upload code with the shared component**

```jsx
import { ModelUploadFlow } from "../components/ModelUploadFlow";

function UploadModal() {
  return <ModelUploadFlow onUploaded={() => window.location.reload()} />;
}
```

Re-export the four existing helper names from `app.models.jsx` during this task so downstream imports remain compatible until tests migrate.

- [ ] **Step 5: Run upload and Models tests**

Run: `cd apps/shopify-app && npm test -- modelUploadFlow.ui.test.js appModels.ui.test.js apiModelUpload.route.test.js presignUpload.server.test.js finalizeUpload.server.test.js`

Expected: PASS.

- [ ] **Step 6: Commit the extraction**

```bash
git add apps/shopify-app/app/components/ModelUploadFlow.jsx apps/shopify-app/app/routes/app.models.jsx apps/shopify-app/test/modelUploadFlow.ui.test.js apps/shopify-app/test/appModels.ui.test.js
git commit -m "refactor(admin): share model upload flow"
```

---

### Task 2: Extract Product Mutations Into A Shared Server Action

**Files:**
- Create: `apps/shopify-app/app/productActions.server.js`
- Modify: `apps/shopify-app/app/routes/app.products.jsx:109-187`
- Create: `apps/shopify-app/test/productActions.server.test.js`
- Modify: `apps/shopify-app/test/appProducts.map.test.js`
- Modify: `apps/shopify-app/test/appProducts.unmap.test.js`
- Modify: `apps/shopify-app/test/appProducts.limit.test.js`

**Interfaces:**
- Produces: `handleProductAction({ request, admin, shop })` returning the same React Router response payloads and status codes as the current Products action.
- Preserves action intents and form fields already used by Products: map/change model and unmap/remove.

- [ ] **Step 1: Add a failing delegation test**

```js
import { describe, expect, it, vi } from "vitest";
import { handleProductAction } from "../app/productActions.server.js";

describe("handleProductAction", () => {
  it("rejects an unknown intent without mutating data", async () => {
    const request = new Request("https://app.test/app", {
      method: "POST",
      body: new URLSearchParams({ intent: "unknown" }),
    });
    const response = await handleProductAction({ request, admin: {}, shop: "shop.test" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Unsupported action." });
  });
});
```

- [ ] **Step 2: Verify the module is absent**

Run: `cd apps/shopify-app && npm test -- productActions.server.test.js`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Move the current action body into `handleProductAction`**

```js
export async function handleProductAction({ request, admin, shop }) {
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  // Move the existing map/change/remove branches here unchanged.
  return Response.json({ error: "Unsupported action." }, { status: 400 });
}
```

Keep plan-limit behavior, metafield publication, retry payloads, model validation, and unmap cleanup exactly as currently implemented. Do not translate technical errors here; return stable error codes plus current messages so the UI can present merchant copy later.

- [ ] **Step 4: Delegate the Products action**

```js
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  return handleProductAction({ request, admin, shop: session.shop });
};
```

- [ ] **Step 5: Run all mutation tests**

Run: `cd apps/shopify-app && npm test -- productActions.server.test.js appProducts.map.test.js appProducts.metafield.test.js appProducts.unmap.test.js appProducts.limit.test.js`

Expected: PASS with unchanged response contracts.

- [ ] **Step 6: Commit the server extraction**

```bash
git add apps/shopify-app/app/productActions.server.js apps/shopify-app/app/routes/app.products.jsx apps/shopify-app/test/productActions.server.test.js apps/shopify-app/test/appProducts.map.test.js apps/shopify-app/test/appProducts.unmap.test.js apps/shopify-app/test/appProducts.limit.test.js
git commit -m "refactor(admin): share product mapping actions"
```

---

### Task 3: Build The Workspace Data Contract

**Files:**
- Create: `apps/shopify-app/app/workspace.server.js`
- Create: `apps/shopify-app/test/workspace.server.test.js`
- Modify: `apps/shopify-app/app/routes/app._index.jsx:1-51`
- Modify: `apps/shopify-app/test/appIndex.loader.test.js`

**Interfaces:**
- Produces: `loadWorkspace({ admin, shop, engineUrl })` returning `{ assets, mappings, counts, usage, guide, themeUrl }`.
- Produces: `workspaceGuide({ assets, mappings, usage })` returning `{ kind, title, detail, action }`.
- Every mapping returned to the UI contains `product`, `modelAsset`, `status`, `previewUrl`, and the product-specific `themeUrl`.
- `counts` is `{ all, live, needsAttention }`.

- [ ] **Step 1: Write failing pure status and guide tests**

```js
import { describe, expect, it } from "vitest";
import { workspaceGuide, workspaceCounts } from "../app/workspace.server.js";

describe("workspace data", () => {
  it("guides a new merchant to upload before choosing a product", () => {
    expect(workspaceGuide({ assets: [], mappings: [], usage: { atLimit: false } })).toMatchObject({
      kind: "setup",
      title: "Upload your first model",
      action: { id: "add-try-on", label: "Upload model" },
    });
  });

  it("counts every non-live mapping as needing attention", () => {
    const mappings = [
      { status: "live" },
      { status: "add-to-theme" },
      { status: "model-issue" },
    ];
    expect(workspaceCounts(mappings)).toEqual({ all: 3, live: 1, needsAttention: 2 });
  });
});
```

- [ ] **Step 2: Run and confirm module-not-found**

Run: `cd apps/shopify-app && npm test -- workspace.server.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement pure status normalization and guide priority**

```js
export function workspaceCounts(mappings) {
  const live = mappings.filter((mapping) => mapping.status === "live").length;
  return { all: mappings.length, live, needsAttention: mappings.length - live };
}

export function workspaceGuide({ assets, mappings, usage }) {
  if (!assets.length) return { kind: "setup", title: "Upload your first model", detail: "Add a ready-to-use eyewear model.", action: { id: "add-try-on", label: "Upload model" } };
  if (!mappings.length) return { kind: "setup", title: "Add try-on to a product", detail: "Choose a model, then a Shopify product.", action: { id: "add-try-on", label: "Add try-on" } };
  const issue = mappings.find((mapping) => mapping.status === "model-issue");
  if (issue) return { kind: "recovery", title: "A model needs attention", detail: issue.product?.title, action: { id: "choose-model", mappingId: issue.id, label: "Choose model" } };
  const theme = mappings.find((mapping) => mapping.status === "add-to-theme");
  if (theme) return { kind: "recovery", title: "Finish storefront setup", detail: theme.product?.title, action: { id: "theme", href: theme.themeUrl, label: "Add to theme" } };
  if (usage.atLimit) return { kind: "recovery", title: "Your plan limit is reached", detail: "Upgrade before adding another product.", action: { id: "plans", href: usage.pricingUrl, label: "View plans" } };
  return { kind: "complete", title: "Everything is live", detail: `${mappings.length} products are ready`, action: null };
}
```

- [ ] **Step 4: Implement `loadWorkspace` by reusing the current Products loader operations**

Move, do not duplicate, product enrichment and URL generation from `app.products.jsx`. Sort model issues and add-to-theme rows before live rows while retaining original database order inside each group. Preserve resilience behavior for deleted Shopify products and failed enrichment calls.

- [ ] **Step 5: Switch the Index loader to `loadWorkspace`**

```js
export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const activePlan = await getActivePlanName(admin, session.shop);
  if (!activePlan) return emptyWorkspace(session.shop);
  return loadWorkspace({ admin, shop: session.shop, engineUrl: resolveEngineUrl(request) });
};
```

Keep the no-plan non-redirect behavior required by the parent layout.

- [ ] **Step 6: Run loader and resilience tests**

Run: `cd apps/shopify-app && npm test -- workspace.server.test.js appIndex.loader.test.js appProducts.loader.test.js appProducts.loaderResilience.test.js appProducts.preview.test.js`

Expected: PASS.

- [ ] **Step 7: Commit the Workspace contract**

```bash
git add apps/shopify-app/app/workspace.server.js apps/shopify-app/app/routes/app._index.jsx apps/shopify-app/test/workspace.server.test.js apps/shopify-app/test/appIndex.loader.test.js
git commit -m "feat(admin): add workspace data contract"
```

---

### Task 4: Build Workspace Guide, Filters, And Product Operations

**Files:**
- Create: `apps/shopify-app/app/components/WorkspaceGuide.jsx`
- Create: `apps/shopify-app/app/components/WorkspaceFilters.jsx`
- Create: `apps/shopify-app/app/components/ProductOperationsList.jsx`
- Create: `apps/shopify-app/test/workspaceComponents.ui.test.js`

**Interfaces:**
- Produces: `filterWorkspaceMappings(mappings, { status, query })` where status is `all`, `live`, or `needs-attention`.
- Produces: `WorkspaceGuide({ guide, onAction })`.
- Produces: `WorkspaceFilters({ counts, status, query, onStatusChange, onQueryChange })`.
- Produces: `ProductOperationsList({ mappings, onPreview, onChangeModel, onRemove })`.

- [ ] **Step 1: Write failing filter and status-action tests**

```js
import { describe, expect, it } from "vitest";
import { filterWorkspaceMappings, primaryActionFor } from "../app/components/ProductOperationsList.jsx";

const rows = [
  { id: "1", status: "live", product: { title: "Willow" }, modelAsset: { displayName: "Clear" } },
  { id: "2", status: "model-issue", product: { title: "Gripz" }, modelAsset: { displayName: "Black" } },
];

it("combines needs-attention and text search", () => {
  expect(filterWorkspaceMappings(rows, { status: "needs-attention", query: "black" }).map((row) => row.id)).toEqual(["2"]);
});

it("assigns one primary recovery action per status", () => {
  expect(primaryActionFor(rows[0])).toMatchObject({ label: "Preview", id: "preview" });
  expect(primaryActionFor(rows[1])).toMatchObject({ label: "Choose model", id: "choose-model" });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/shopify-app && npm test -- workspaceComponents.ui.test.js`

Expected: FAIL because the component modules do not exist.

- [ ] **Step 3: Implement deterministic filtering and contextual actions**

```js
export function filterWorkspaceMappings(mappings, { status, query }) {
  const needle = query.trim().toLocaleLowerCase();
  return mappings.filter((mapping) => {
    const statusMatch = status === "all" || (status === "live" ? mapping.status === "live" : mapping.status !== "live");
    const text = `${mapping.product?.title || ""} ${mapping.modelAsset?.displayName || mapping.modelAsset?.originalFilename || ""}`.toLocaleLowerCase();
    return statusMatch && (!needle || text.includes(needle));
  });
}

export function primaryActionFor(mapping) {
  if (mapping.status === "live") return { id: "preview", label: "Preview" };
  if (mapping.status === "add-to-theme") return { id: "theme", label: "Add to theme", href: mapping.themeUrl };
  if (mapping.status === "model-issue") return { id: "choose-model", label: "Choose model" };
  return { id: "plans", label: "View plans", href: mapping.usage?.pricingUrl };
}
```

The row overflow contains only Preview, Change model, and Remove try-on. Product images use an empty neutral placeholder with the product title as accessible text when Shopify returns no image.

- [ ] **Step 4: Implement guide and filter controls with accessible state**

Use real button semantics. Set `aria-pressed` on summary filters, associate the search input with `aria-label="Search products and models"`, and put status text beside its badge so color is never the only signal. The complete guide renders as a slim status row rather than a panel.

- [ ] **Step 5: Run component tests**

Run: `cd apps/shopify-app && npm test -- workspaceComponents.ui.test.js`

Expected: PASS.

- [ ] **Step 6: Commit the operational components**

```bash
git add apps/shopify-app/app/components/WorkspaceGuide.jsx apps/shopify-app/app/components/WorkspaceFilters.jsx apps/shopify-app/app/components/ProductOperationsList.jsx apps/shopify-app/test/workspaceComponents.ui.test.js
git commit -m "feat(admin): add workspace operations components"
```

---

### Task 5: Build The Upload-First Add Try-On Flow

**Files:**
- Create: `apps/shopify-app/app/components/AddTryOnFlow.jsx`
- Create: `apps/shopify-app/test/addTryOnFlow.ui.test.js`
- Modify: `apps/shopify-app/app/routes/app._index.jsx`

**Interfaces:**
- Produces: `addTryOnReducer(state, action)` with state `{ open, step, modelAsset, product, error, publishing }`.
- Produces: `AddTryOnFlow({ assets, initialModelId, open, onClose, onPublished })`.
- Step values are exactly `model`, `product`, and `review`.
- Product selection calls `shopify.resourcePicker({ type: "product", action: "select" })` only after a model exists.

- [ ] **Step 1: Write failing reducer tests for order and preserved state**

```js
import { describe, expect, it } from "vitest";
import { addTryOnReducer, initialAddTryOnState } from "../app/components/AddTryOnFlow.jsx";

it("cannot advance to product selection without a model", () => {
  expect(addTryOnReducer(initialAddTryOnState, { type: "next" }).step).toBe("model");
});

it("preserves both selections after a publish error", () => {
  const state = { ...initialAddTryOnState, step: "review", modelAsset: { id: "m1" }, product: { id: "p1" } };
  expect(addTryOnReducer(state, { type: "publish-error", message: "Could not publish. Try again." })).toMatchObject({
    step: "review",
    modelAsset: { id: "m1" },
    product: { id: "p1" },
    error: "Could not publish. Try again.",
  });
});

it("selects a newly uploaded model and advances", () => {
  const asset = { id: "new-model", status: "READY" };
  expect(addTryOnReducer(initialAddTryOnState, { type: "model-selected", asset })).toMatchObject({ step: "product", modelAsset: asset });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/shopify-app && npm test -- addTryOnFlow.ui.test.js`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the reducer and model step**

```js
export const initialAddTryOnState = {
  open: false,
  step: "model",
  modelAsset: null,
  product: null,
  error: null,
  publishing: false,
};

export function addTryOnReducer(state, action) {
  switch (action.type) {
    case "open": return { ...initialAddTryOnState, open: true, modelAsset: action.asset || null, step: action.asset ? "product" : "model" };
    case "model-selected": return { ...state, modelAsset: action.asset, step: "product", error: null };
    case "product-selected": return { ...state, product: action.product, step: "review", error: null };
    case "back": return { ...state, step: state.step === "review" ? "product" : "model", error: null };
    case "publishing": return { ...state, publishing: true, error: null };
    case "publish-error": return { ...state, publishing: false, error: action.message };
    case "close": return initialAddTryOnState;
    default: return state;
  }
}
```

The model step lists ready models first and embeds `ModelUploadFlow`. Its upload callback dispatches `model-selected` so upload automatically advances to product choice.

- [ ] **Step 4: Implement product choice and review/publish**

Display the chosen product image/title after resource-picker selection. The review step displays product and model together, uses the existing `PreviewPanel`, and submits this exact payload through a route fetcher:

```jsx
<fetcher.Form method="post">
  <input type="hidden" name="intent" value="map" />
  <input type="hidden" name="productId" value={state.product.id} />
  <input type="hidden" name="productHandle" value={state.product.handle || ""} />
  <input type="hidden" name="modelAssetId" value={state.modelAsset.id} />
  <s-button type="submit" variant="primary" loading={state.publishing}>Publish try-on</s-button>
</fetcher.Form>
```

Picker cancellation leaves the model selected and the flow on the product step. A publish error stays on review with one `Try again` action.

- [ ] **Step 5: Test picker cancellation, reselection, and retry state**

Add cases asserting: cancellation does not close/reset; a later product replaces the earlier selection; `publish-error` retains both selections; `close` resets only after explicit close or success.

- [ ] **Step 6: Run the add-flow tests**

Run: `cd apps/shopify-app && npm test -- addTryOnFlow.ui.test.js modelUploadFlow.ui.test.js appProducts.ui.test.js`

Expected: PASS.

- [ ] **Step 7: Commit the add flow**

```bash
git add apps/shopify-app/app/components/AddTryOnFlow.jsx apps/shopify-app/app/routes/app._index.jsx apps/shopify-app/test/addTryOnFlow.ui.test.js
git commit -m "feat(admin): add upload-first try-on flow"
```

---

### Task 6: Compose The Unified Workspace Route

**Files:**
- Modify: `apps/shopify-app/app/routes/app._index.jsx`
- Create: `apps/shopify-app/app/styles/workspace.css`
- Create: `apps/shopify-app/test/appIndex.workspace.test.js`
- Modify: `apps/shopify-app/test/appIndex.loader.test.js`

**Interfaces:**
- `/app` loader consumes `loadWorkspace` from Task 3.
- `/app` action delegates to `handleProductAction` from Task 2.
- The route composes the components from Tasks 4 and 5 and accepts optional `?add=1&model=<asset-id>`.

- [ ] **Step 1: Write failing route-composition assertions**

```js
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../app/routes/app._index.jsx", import.meta.url), "utf8");

it("makes Add try-on the only page-level primary action", () => {
  expect(source).toContain('heading="Workspace"');
  expect(source).toContain("Add try-on");
  expect(source).not.toContain("Go to products");
});

it("uses guide, filters, operations, and upload-first flow", () => {
  for (const name of ["WorkspaceGuide", "WorkspaceFilters", "ProductOperationsList", "AddTryOnFlow"]) {
    expect(source).toContain(name);
  }
});
```

- [ ] **Step 2: Run and verify the old Home page fails the assertions**

Run: `cd apps/shopify-app && npm test -- appIndex.workspace.test.js appIndex.loader.test.js`

Expected: FAIL because the route still renders `AR Try-on` and `Go to products`.

- [ ] **Step 3: Replace the Home UI with Workspace composition**

```jsx
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  return handleProductAction({ request, admin, shop: session.shop });
};

export default function Workspace() {
  const data = useLoaderData();
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const visibleMappings = filterWorkspaceMappings(data.mappings, { status, query });
  // Compose one page-level action, conditional guide, filters, list, and flow.
}
```

On successful publication: close the dialog, show `shopify.toast.show("Try-on published")`, revalidate loader data, and allow the server's attention-first ordering to put the product at the top. Show the Add-to-theme recovery action only when its refreshed status requires it.

- [ ] **Step 4: Add restrained responsive styles**

```css
.workspace-shell { display: grid; gap: 24px; }
.workspace-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.workspace-row { display: grid; grid-template-columns: minmax(220px, 2fr) minmax(140px, 1fr) 140px auto; gap: 16px; align-items: center; }
.workspace-panel { border: 1px solid #dedede; border-radius: 6px; background: #fff; }
.workspace-action:focus-visible, .workspace-filter:focus-visible { outline: 2px solid #005bd3; outline-offset: 2px; }
@media (max-width: 640px) {
  .workspace-summary { display: flex; overflow-x: auto; }
  .workspace-summary > * { min-width: 132px; }
  .workspace-row { grid-template-columns: 1fr auto; }
  .workspace-row__model, .workspace-row__status { grid-column: 1 / -1; }
}
@media (prefers-reduced-motion: reduce) {
  .workspace-shell *, .workspace-shell *::before, .workspace-shell *::after { scroll-behavior: auto; transition-duration: 0.01ms !important; }
}
```

No card may be nested inside `.workspace-panel`; sections use unframed spacing or a single border.

- [ ] **Step 5: Add route tests for the four merchant states**

Cover empty merchant, live mapping, add-to-theme mapping with exact product URL, model issue, and at-limit data. Assert each state exposes exactly one contextual primary action and no technical terms such as `metafield`, `GLB parsing`, or `render pipeline`.

- [ ] **Step 6: Run Workspace tests**

Run: `cd apps/shopify-app && npm test -- appIndex.workspace.test.js appIndex.loader.test.js workspace.server.test.js workspaceComponents.ui.test.js addTryOnFlow.ui.test.js`

Expected: PASS.

- [ ] **Step 7: Commit the unified route**

```bash
git add apps/shopify-app/app/routes/app._index.jsx apps/shopify-app/app/styles/workspace.css apps/shopify-app/test/appIndex.workspace.test.js apps/shopify-app/test/appIndex.loader.test.js
git commit -m "feat(admin): launch guided operations workspace"
```

---

### Task 7: Connect Models, Simplify Navigation, And Redirect Products

**Files:**
- Modify: `apps/shopify-app/app/routes/app.models.jsx`
- Modify: `apps/shopify-app/app/routes/app.products.jsx`
- Modify: `apps/shopify-app/app/routes/app.jsx`
- Modify: `apps/shopify-app/test/appModels.ui.test.js`
- Create: `apps/shopify-app/test/appNavigation.ui.test.js`
- Modify: `apps/shopify-app/test/appProducts.loader.test.js`

**Interfaces:**
- Models success navigation is `/app?add=1&model=<asset-id>`.
- Products loader returns `redirect("/app")` after `authenticate.admin(request)`.
- Global navigation contains `Workspace` and `Models`; contextual support remains available from Workspace but is not a top-level workflow.

- [ ] **Step 1: Write failing handoff, redirect, and navigation tests**

```js
it("hands an uploaded model directly to the Workspace add flow", () => {
  expect(modelsSource).toContain("/app?add=1&model=");
});

it("keeps only operational destinations in global navigation", () => {
  expect(appSource).toContain('>Workspace</s-link>');
  expect(appSource).toContain('>Models</s-link>');
  expect(appSource).not.toContain('>Products</s-link>');
  expect(appSource).not.toContain('>Help</s-link>');
});
```

Add a loader test that mocks authentication and expects `/app/products` to return status `302` with `Location: /app`.

- [ ] **Step 2: Run the tests and verify current behavior fails**

Run: `cd apps/shopify-app && npm test -- appNavigation.ui.test.js appModels.ui.test.js appProducts.loader.test.js`

Expected: FAIL because navigation still shows Home, Products, and Help and Products still loads its own page.

- [ ] **Step 3: Add the post-upload handoff in Models**

```jsx
const navigate = useNavigate();
<ModelUploadFlow
  onUploaded={(asset) => navigate(`/app?add=1&model=${encodeURIComponent(asset.id)}`)}
/>
```

The Models page remains available for rename, status inspection, usage, and deleting unused models. Do not auto-navigate for rename or delete.

- [ ] **Step 4: Replace the Products page with an authenticated redirect**

```jsx
import { redirect } from "react-router";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return redirect("/app");
};

export default function ProductsRedirect() { return null; }
```

Remove obsolete Products UI helpers only after tests have migrated to their new component modules. Keep the route-level boundary headers.

- [ ] **Step 5: Simplify app navigation**

```jsx
<s-app-nav>
  <s-link href="/app">Workspace</s-link>
  <s-link href="/app/models">Models</s-link>
</s-app-nav>
```

Keep `/app/additional` routable for old links, but move support email and policy links into the Workspace's contextual support area.

- [ ] **Step 6: Run navigation, mapping, and Models tests**

Run: `cd apps/shopify-app && npm test -- appNavigation.ui.test.js appModels.ui.test.js appModels.manage.test.js appProducts.loader.test.js productActions.server.test.js`

Expected: PASS.

- [ ] **Step 7: Commit route migration**

```bash
git add apps/shopify-app/app/routes/app.models.jsx apps/shopify-app/app/routes/app.products.jsx apps/shopify-app/app/routes/app.jsx apps/shopify-app/test/appModels.ui.test.js apps/shopify-app/test/appNavigation.ui.test.js apps/shopify-app/test/appProducts.loader.test.js
git commit -m "feat(admin): route merchants through workspace"
```

---

### Task 8: Accessibility, Responsive Acceptance, And Full Verification

**Files:**
- Modify: `apps/shopify-app/test/appIndex.workspace.test.js`
- Modify: `apps/shopify-app/test/workspaceComponents.ui.test.js`
- Modify: `apps/shopify-app/app/styles/workspace.css`
- Modify: only implementation files implicated by failing acceptance tests.

**Interfaces:**
- No new interfaces; this task verifies the complete feature against the approved spec.

- [ ] **Step 1: Add explicit acceptance assertions**

```js
it("labels search, overflow, product images, and dialog actions", () => {
  expect(filtersSource).toContain('aria-label="Search products and models"');
  expect(listSource).toContain("accessibilityLabel");
  expect(flowSource).toContain('heading="Add try-on"');
});

it("keeps narrow rows stacked and status filters scrollable", () => {
  expect(css).toContain("@media (max-width: 640px)");
  expect(css).toContain("overflow-x: auto");
  expect(css).toContain("grid-column: 1 / -1");
});
```

Also assert the exact selected product handle is passed to its `themeUrl`, and existing mapping changes remain allowed when usage is at the plan limit.

- [ ] **Step 2: Run focused acceptance tests**

Run: `cd apps/shopify-app && npm test -- appIndex.workspace.test.js workspaceComponents.ui.test.js addTryOnFlow.ui.test.js appProducts.limit.test.js adminLinks.server.test.js`

Expected: PASS. Fix only the behavior named by a failing assertion.

- [ ] **Step 3: Run the complete Shopify app suite**

Run: `cd apps/shopify-app && npm test`

Expected: all tests pass with zero skipped or unhandled errors.

- [ ] **Step 4: Run typecheck and production build**

Run: `cd apps/shopify-app && npm run typecheck && npm run build`

Expected: both commands exit 0; React Router emits the production client and server bundles.

- [ ] **Step 5: Run the AR engine regression suite**

Run: `npm test`

Expected: all engine tests pass; the admin rewrite does not alter tracking, model articulation, or occlusion behavior.

- [ ] **Step 6: Perform manual Shopify Admin acceptance**

Verify in the embedded app at desktop and a viewport no wider than 640px:

1. A new merchant sees Upload model as the single next action.
2. Upload automatically selects the model, then product picker opens only from step two.
3. Picker cancellation preserves the model; reselection works.
4. Publish success closes the flow, refreshes the row, and shows a toast.
5. Add to theme opens the exact selected product's theme-editor preview path.
6. Live, model issue, and plan limit each show one correct primary action.
7. Search combines with each status filter and can be cleared.
8. Keyboard focus is visible and returns to Add try-on after the dialog closes.
9. Narrow rows stack cleanly with no overlap or hidden primary action.
10. `/app/products` returns to Workspace inside the authenticated app.

- [ ] **Step 7: Commit verification fixes**

```bash
git add apps/shopify-app
git commit -m "test(admin): verify guided workspace workflows"
```

---

## Completion Gate

- [ ] Confirm every requirement in the design spec is represented by a task or acceptance check above.
- [ ] Run the writing-plans placeholder scan; no prohibited placeholder phrases may remain.
- [ ] Confirm shared signatures match everywhere: `loadWorkspace`, `handleProductAction`, `ModelUploadFlow`, `AddTryOnFlow`, `WorkspaceGuide`, `WorkspaceFilters`, and `ProductOperationsList`.
- [ ] Confirm the worktree is clean except for intentional commits.
- [ ] Push the design-spec commit `c2dd381` and all implementation commits only after the verification gate passes.
