# Admin Guided Operations Workspace Design

## Objective

Redesign the merchant admin around one low-friction workspace that combines:

- guided setup for merchants who are not yet live;
- efficient product operations for returning merchants;
- direct recovery actions when a product needs attention;
- a restrained, Shopify-native visual language.

The primary success criterion is that a merchant can understand the next action without searching, interpreting technical language, or moving between redundant screens.

## Product Principles

1. Show one obvious primary action per context.
2. Treat every extra click, field, modal, and decision as a cost that must justify itself.
3. Keep setup guidance visible only while work remains.
4. Put daily product operations on the default screen.
5. Explain problems in merchant language and pair each problem with one recovery action.
6. Preserve selections and progress after recoverable failures.
7. Follow Shopify Admin conventions rather than presenting a separate SaaS-style interface.
8. Design loading, empty, disabled, success, error, keyboard, and mobile states explicitly.

## Information Architecture

### Workspace

`/app` becomes the default merchant destination and unified product workspace. It replaces the separate Home and Products experiences.

The workspace contains, in order:

1. Page heading and one `Add try-on` primary action.
2. A compact setup or recovery guide when action is required.
3. Clickable product-status summaries that filter the product list.
4. Search and status tabs.
5. The product operations table.

The old Products route redirects to Workspace so existing bookmarks and internal links continue to work.

### Models

Models remains a dedicated library for:

- uploading models;
- inspecting processing state;
- renaming models;
- seeing product usage;
- deleting unused models.

After a successful upload, the merchant can continue directly into the add flow with that model selected.

### Help And Billing

Help is contextual. Recovery guidance and support links appear beside the relevant failure instead of requiring a separate journey. A small support destination may remain in the global page header.

Plan information appears in Workspace only when it affects usage or blocks an action. There is no standalone Settings destination until the product contains genuine merchant-configurable settings.

## Primary Add Flow

`Add try-on` opens one focused flow in this exact order:

1. **Upload or select model**
   - Existing ready models are immediately selectable.
   - Upload is available in the same step.
   - A successful upload selects the new model automatically.
2. **Choose product**
   - Use Shopify's native product picker.
   - Show the selected product's image and title after selection.
3. **Review and publish**
   - Show the selected model and product together.
   - Provide a merchant preview.
   - Use one clear confirmation action.

After publishing:

- close the flow;
- place the affected product at the top of the workspace;
- update its status immediately;
- show a brief success toast;
- surface `Add to theme` only when the theme block still needs installation.

Recoverable failures remain inside the current step, preserve all selections, and provide one retry action.

## Guided Workspace Behavior

The guide occupies one compact panel above the operations area only when setup or recovery work remains.

For first-run setup it presents the current progress through:

1. Upload model.
2. Choose product.
3. Publish mapping.
4. Add the storefront block and verify try-on.

Completed steps collapse automatically. The next required step owns the panel's primary action.

For returning merchants, the guide shows the highest-priority unresolved issue across mapped products. When no work remains, it collapses into a slim `Everything is live` status row.

The guide must not duplicate controls already visible in a product row unless it is intentionally highlighting the single next action.

## Operations Workspace

### Status Summaries

The workspace shows three concise, clickable summaries:

- All products.
- Live.
- Needs attention.

These are functional filters, not decorative metrics. Selecting one updates the product list and corresponding status tab.

### Product List

Products needing attention sort before live products. Within each group, preserve a stable and predictable ordering.

Each row contains:

- product image and title;
- assigned model name;
- one plain-language status;
- one primary contextual action;
- a compact overflow menu for secondary actions.

Routine secondary actions are:

- Preview.
- Change model.
- Remove try-on.

Search filters by product and model name. Filters and search must combine predictably and have a clear reset state.

## Status And Recovery Model

The merchant-facing statuses are:

| Status | Meaning | Primary action |
| --- | --- | --- |
| Live | Try-on has been verified on the storefront. | Preview |
| Add to theme | Product and model are mapped, but the storefront block is missing. | Add to theme |
| Model issue | The assigned model failed processing or is unavailable. | Choose model or Retry |
| Plan limit | The requested addition exceeds the current plan. | View plans |

Status language must not expose implementation details such as metafields, GLB parsing, storage keys, GraphQL, or render pipelines.

`Add to theme` must retain the selected product's exact theme-editor preview path and the canonical app block identity.

Errors appear beside the action that failed. Server logs retain technical diagnostics. A failed action must not erase the merchant's current selection or force the whole page to reload.

## Visual Design

The interface follows Shopify Admin conventions:

- white and light-gray page surfaces;
- restrained neutral borders;
- black primary actions;
- Shopify-compatible semantic colors for success, warning, and critical states;
- compact controls and panels with radii no greater than 6px;
- a consistent 16px to 24px spacing rhythm;
- product images used for recognition, not decoration;
- familiar icons for upload, preview, search, and overflow actions;
- concise headings sized for an operational interface.

Avoid:

- marketing hero sections;
- oversized display type;
- decorative illustrations;
- gradients and ornamental color effects;
- nested cards;
- explanatory feature copy;
- multiple competing primary actions.

## Responsive And Accessible Behavior

On narrow screens, the product table becomes stacked product rows while retaining the same information and action order. Status filters can scroll horizontally without shrinking labels beyond readability.

Requirements:

- all workflows remain usable with keyboard navigation;
- visible focus indicators appear on every interactive control;
- icon-only controls have accessible labels and tooltips where needed;
- loading states preserve layout dimensions;
- text never overlaps or truncates the only available action;
- dialogs trap focus and restore it to their trigger on close;
- reduced-motion preferences are honored;
- status is never communicated by color alone.

## Technical Structure

The unified Workspace route reuses the existing server-backed product actions, metafield publishing, billing limits, product enrichment, preview URLs, theme deep links, and status computation.

Reusable UI responsibilities should be separated into focused components:

- workspace setup/recovery guide;
- status filters;
- searchable product operations list;
- product status and contextual action;
- upload-first add flow;
- model selection/upload step;
- product selection step;
- review/publish step;
- preview presentation;
- error and retry state.

Models remains independently routable. Existing links to Products must redirect to Workspace without losing the authenticated embedded-app context.

## Verification

Automated coverage must include:

1. New merchant with no models or mappings.
2. Upload-first flow through successful product publishing.
3. Existing-model selection without upload.
4. Product picker cancellation and reselection.
5. Mapping and storefront publishing failures with preserved state.
6. Theme-block recovery for the exact selected product.
7. Live, add-to-theme, model-issue, and plan-limit states.
8. Search and combined status filtering.
9. Existing mapping changes at the plan limit.
10. Responsive product-row rendering.
11. Keyboard and accessible-label expectations.
12. Legacy Products-route redirection.
13. Production React Router build.
14. Existing Shopify application tests and AR engine tests remaining green.

Manual acceptance should test the complete first-run flow and returning-merchant workflow in Shopify Admin on desktop and a narrow viewport. No unresolved step may require the merchant to infer where to go next.
