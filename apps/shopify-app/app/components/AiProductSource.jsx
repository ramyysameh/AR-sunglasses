/* eslint-disable react/prop-types -- lightweight props, same as the other flows */

export function productTooFewPhotos(count) {
  return `This product has only ${count} ${count === 1 ? 'photo' : 'photos'}. Add more to the product, or use Upload photos instead.`
}

function PhotoToggle({ image, label, index, isSelected, atLimit, disabled, onToggle }) {
  return (
    <button
      type="button"
      aria-pressed={isSelected}
      aria-label={image.altText || `${label} photo ${index + 1}`}
      {...(atLimit ? { 'aria-disabled': 'true' } : {})}
      disabled={disabled}
      onClick={onToggle}
      style={{
        position: 'relative',
        padding: 0,
        background: 'transparent',
        cursor: disabled || atLimit ? 'default' : 'pointer',
        opacity: atLimit ? 0.6 : 1,
        borderRadius: '8px',
        overflow: 'hidden',
        border: `3px solid ${isSelected ? '#005bd3' : 'transparent'}`,
      }}
    >
      <img
        src={image.thumbnailUrl}
        alt={image.altText || ''}
        style={{ display: 'block', width: '100%', aspectRatio: '1', objectFit: 'contain' }}
      />
      {isSelected && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute', top: '4px', right: '4px', width: '20px', height: '20px',
            lineHeight: '20px', borderRadius: '50%', background: '#005bd3', color: '#fff',
            fontSize: '13px', textAlign: 'center',
          }}
        >
          ✓
        </span>
      )}
    </button>
  )
}

function ProductRow({ product, disabled, onToggle, onRemove }) {
  const tooFew = product.images.length < 3
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="space-between">
          <s-text type="strong">{product.title}</s-text>
          <button
            type="button"
            aria-label={`Remove ${product.title}`}
            disabled={disabled}
            onClick={onRemove}
            style={{
              border: 0,
              background: 'transparent',
              cursor: disabled ? 'default' : 'pointer',
              fontSize: '18px',
              lineHeight: 1,
              minWidth: '32px',
              minHeight: '32px',
              padding: 0,
            }}
          >
            ×
          </button>
        </s-stack>
        {tooFew ? (
          <s-text color="subdued">Needs at least 3 photos. {productTooFewPhotos(product.images.length)}</s-text>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: '8px' }}>
              {product.images.map((image, index) => {
                const isSelected = product.selected.includes(image.id)
                return (
                  <PhotoToggle
                    key={image.id}
                    image={image}
                    label={product.title}
                    index={index}
                    isSelected={isSelected}
                    atLimit={!isSelected && product.selected.length >= 4}
                    disabled={disabled}
                    onToggle={() => onToggle(image.id)}
                  />
                )
              })}
            </div>
            <s-text color="subdued">{product.selected.length} of 4 selected</s-text>
          </>
        )}
      </s-stack>
    </s-box>
  )
}

// Presentational half of the "From products" source: picked products, each
// with its photos as keyboard-accessible toggles. State and requests live in
// AiModelFlow. Native <button>s, because React 18 drops onChange/custom events
// on s-* elements but onClick on a native button works.
export default function AiProductSource({ picked, disabled, onChoose, onToggle, onRemove }) {
  return (
    <s-stack direction="block" gap="base">
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-button variant={picked.length ? 'secondary' : 'primary'} disabled={disabled} onClick={onChoose}>
          {picked.length ? 'Change products' : 'Choose products'}
        </s-button>
        <s-text color="subdued">Up to 5 products at a time.</s-text>
      </s-stack>
      {picked.length > 0 && (
        <s-text color="subdued">
          For each product, tick 3 or 4 clear photos of the frame from different angles. Skip lifestyle or worn photos if you can.
        </s-text>
      )}
      {picked.map((product) => (
        <ProductRow
          key={product.id}
          product={product}
          disabled={disabled}
          onToggle={(imageId) => onToggle(product.id, imageId)}
          onRemove={() => onRemove(product.id)}
        />
      ))}
    </s-stack>
  )
}
