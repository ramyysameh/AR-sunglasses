/* eslint-disable react/prop-types -- plain JSX component, no PropTypes library in use */
import StatusBadge from './StatusBadge'
import TopLevelAdminAction from './TopLevelAdminAction'

const STATUS_DETAILS = {
  live: { label: 'Live', tone: 'success' },
  'add-to-theme': { label: 'Add to theme', tone: 'warning' },
  'model-issue': { label: 'Model issue', tone: 'critical' },
  'plan-limit': { label: 'Plan limit', tone: 'warning' },
}

// A status this build does not know about is reported as unknown rather than
// borrowed from another row type: labelling it "Plan limit" told merchants the
// wrong reason their try-on was not live.
const UNKNOWN_STATUS = { label: 'Needs attention', tone: 'warning' }

export function filterWorkspaceMappings(mappings, { status, query }) {
  const needle = query.trim().toLocaleLowerCase()

  return mappings.filter((mapping) => {
    const statusMatch = status === 'all'
      || (status === 'live' ? mapping.status === 'live' : mapping.status !== 'live')
    const modelName = mapping.modelAsset?.displayName
      || mapping.modelAsset?.label
      || mapping.modelAsset?.originalFilename
      || mapping.modelAsset?.filename
      || ''
    const text = `${mapping.product?.title || ''} ${modelName}`.toLocaleLowerCase()
    return statusMatch && (!needle || text.includes(needle))
  })
}

export function primaryActionFor(mapping, pricingUrl) {
  if (mapping.status === 'live') return { id: 'preview', label: 'Preview' }
  if (mapping.status === 'add-to-theme') {
    return { id: 'theme', label: 'Add to theme', href: mapping.themeUrl }
  }
  if (mapping.status === 'model-issue') return { id: 'choose-model', label: 'Choose model' }
  if (
    mapping.status === 'plan-limit'
    && typeof pricingUrl === 'string'
    && pricingUrl.trim()
  ) {
    return { id: 'plans', label: 'View plans', href: pricingUrl }
  }
  return null
}

function modelName(modelAsset) {
  return modelAsset?.displayName
    || modelAsset?.label
    || modelAsset?.originalFilename
    || modelAsset?.filename
    || 'Model unavailable'
}

function ProductImage({ product }) {
  const title = product?.title ?? 'Product unavailable'
  if (product?.imageUrl) {
    return (
      <s-thumbnail
        src={product.imageUrl}
        alt={product.imageAlt || title}
        size="small"
      ></s-thumbnail>
    )
  }

  return (
    <s-box
      className="workspace-product-placeholder"
      role="img"
      aria-label={`No image available for ${title}`}
      background="subdued"
      borderRadius="base"
    ></s-box>
  )
}

function PrimaryAction({ action, mapping, onPreview, onChangeModel }) {
  if (!action) return null

  if (action.id === 'preview') {
    return (
      <s-button variant="primary" onClick={() => onPreview(mapping)}>
        {action.label}
      </s-button>
    )
  }

  if (action.id === 'choose-model') {
    return (
      <s-button variant="primary" onClick={() => onChangeModel(mapping)}>
        {action.label}
      </s-button>
    )
  }

  if ((action.id === 'theme' || action.id === 'plans') && action.href) {
    // Both destinations live in the Shopify admin and cannot be embedded in
    // this app's iframe. <s-button href target="_top"> does not reliably break
    // out of the frame -- App Bridge intercepts navigation from Polaris s-*
    // components -- so this row action used to render and do nothing.
    return (
      <TopLevelAdminAction
        href={action.href}
        variant="primary"
        accessibilityLabel={action.label}
      >
        {action.label}
      </TopLevelAdminAction>
    )
  }

  return null
}

export default function ProductOperationsList({
  mappings,
  totalCount = mappings.length,
  pricingUrl,
  guidedMappingId = null,
  onPreview,
  onChangeModel,
  onRemove,
}) {
  if (mappings.length === 0) {
    if (totalCount === 0) {
      return (
        <s-stack direction="block" gap="small-200">
          <s-text type="strong">Add try-on to your first product</s-text>
          <s-paragraph>Use Add try-on to choose frames and a product.</s-paragraph>
        </s-stack>
      )
    }
    return <s-paragraph>No products match these filters.</s-paragraph>
  }

  return (
    <s-table variant="auto">
      <s-table-header-row>
        <s-table-header listSlot="primary">Product</s-table-header>
        <s-table-header>Model</s-table-header>
        <s-table-header>Status</s-table-header>
        <s-table-header>Actions</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {mappings.map((mapping) => {
          const title = mapping.product?.title ?? 'Product unavailable'
          const status = STATUS_DETAILS[mapping.status] ?? UNKNOWN_STATUS
          const primaryAction = mapping.id === guidedMappingId
            ? null
            : primaryActionFor(mapping, pricingUrl)

          return (
            <s-table-row key={mapping.id} className="workspace-row">
              <s-table-cell>
                <s-stack className="workspace-product-cell" direction="inline" gap="small-500" alignItems="center">
                  <ProductImage product={mapping.product} />
                  <s-text type="strong">{title}</s-text>
                </s-stack>
              </s-table-cell>
              <s-table-cell>{modelName(mapping.modelAsset)}</s-table-cell>
              <s-table-cell>
                <StatusBadge status={status} />
              </s-table-cell>
              <s-table-cell>
                <s-stack direction="inline" gap="small-500" alignItems="center">
                  <PrimaryAction
                    action={primaryAction}
                    mapping={mapping}
                    onPreview={onPreview}
                    onChangeModel={onChangeModel}
                  />
                  <s-button
                    variant="tertiary"
                    icon="menu-vertical"
                    accessibilityLabel={`Actions for ${title}`}
                    commandFor={`workspace-actions-${mapping.id}`}
                  ></s-button>
                  <s-menu
                    id={`workspace-actions-${mapping.id}`}
                    accessibilityLabel={`Actions for ${title}`}
                  >
                    <s-button icon="view" onClick={() => onPreview(mapping)}>Preview</s-button>
                    <s-button icon="edit" onClick={() => onChangeModel(mapping)}>Change model</s-button>
                    <s-button icon="delete" tone="critical" onClick={() => onRemove(mapping)}>
                      Remove try-on
                    </s-button>
                  </s-menu>
                </s-stack>
              </s-table-cell>
            </s-table-row>
          )
        })}
      </s-table-body>
    </s-table>
  )
}
