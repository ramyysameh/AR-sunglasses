# Task 4 Report: Guided Workspace Operations Components

## Status

Complete. Added standalone Workspace guide, status/search filters, and product operations components without changing Home page composition.

## Implementation

- Added `WorkspaceGuide` for compact setup/recovery guidance and a slim completed status row.
- Added `WorkspaceFilters` with three real status filter buttons, pressed state, counts, and labelled product/model search.
- Added `ProductOperationsList` with stable combined filtering, normalized status presentation, product image fallback, one contextual primary action, and the exact Preview/Change model/Remove try-on overflow set.
- Passed page-level `pricingUrl` explicitly to `ProductOperationsList` and `primaryActionFor`; mappings remain free of page usage data.
- Reused Shopify web components plus the existing `StatusBadge` conventions. Task 6 remains the owner of page composition.

## TDD And Verification

- RED: `npm test -- workspaceComponents.ui.test.js` failed because the component modules did not exist.
- GREEN: focused component tests passed, 5 tests.
- Adjacent workspace/UI verification passed, 3 files and 21 tests.
- Changed-file ESLint passed.
- `npm run typecheck` passed.
- `git diff --check` passed.

## Self-review

- Filtering combines `all`, `live`, or `needs-attention` with case-insensitive product/model search and preserves incoming order.
- Primary action selection covers Live, Add to theme, Model issue, and Plan limit with no per-mapping usage mutation.
- Every row has one primary action; overflow menus contain only the three permitted secondary actions.
- Product imagery always has accessible text, including missing-image and deleted-product fallbacks.
- Status text remains visible, filter state is programmatic, and the search control is explicitly labelled.
- No new dependencies, nested cards, gradients, marketing copy, route composition, or unrelated changes were introduced.

## Concerns

None.

## Fix Round 1

Commit: this atomic fix-round commit; exact SHA is reported in the task result because a commit cannot contain its own hash.

### Changes

- Replaced the generic non-link primary-action fallback with explicit dispatch by action ID.
- Preview calls `onPreview(mapping)` and Choose model calls `onChangeModel(mapping)`; theme and plan actions are destination-only links.
- Plan-limit recovery renders View plans only when the page supplies a non-empty `pricingUrl`. Without it, the row retains its plain Plan limit status and no misleading primary action is rendered.
- Added `role="group"` and an accessible label to the status-filter controls.
- Added direct production-handler interaction coverage for exact status/search callback values, Preview and Change model mapping payloads, plan destinations and missing-pricing behavior, and guide callbacks/links.

### TDD And Verification

- RED: focused tests failed because the filter container lacked group semantics and a missing-pricing View plans button called `onChangeModel`.
- GREEN: `npm test -- workspaceComponents.ui.test.js` passed, 9 tests.
- Adjacent verification: `npm test -- workspaceComponents.ui.test.js workspace.server.test.js appProducts.ui.test.js` passed, 3 files and 25 tests.
- Targeted ESLint passed for all Task 4 components and tests.
- `npm run typecheck` passed.
- `git diff --check` passed.

### Self-review

- Every primary action ID now has an explicit rendering/dispatch branch; unknown or unavailable actions render nothing.
- A missing plan URL has no callable path to model selection.
- Tests invoke real component handlers rather than asserting markup alone, while retaining focused accessibility/render contracts for custom elements.
- No route composition, dependencies, unrelated files, or prior-task behavior changed.

### Concerns

None.
