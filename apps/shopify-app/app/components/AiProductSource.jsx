/* eslint-disable react/prop-types -- lightweight props, same as the other flows */

// Presentational half of the "From a product" source: the chosen product, its
// photos as keyboard-accessible toggles, and the guidance. State and requests
// live in AiModelFlow. Native <button>s, because React 18 drops onChange/custom
// events on s-* elements but onClick on a native button works.
export default function AiProductSource({ product, images, selected, disabled, onChoose, onToggle }) {
  return (
    <s-stack direction="block" gap="base">
      <s-stack direction="inline" gap="small-200" alignItems="center">
        {product && <s-text type="strong">{product.title}</s-text>}
        <s-button variant={product ? 'secondary' : 'primary'} disabled={disabled} onClick={onChoose}>
          {product ? 'Change product' : 'Choose product'}
        </s-button>
      </s-stack>
      {product && images.length > 0 && (
        <>
          <s-text color="subdued">
            Tick 3 or 4 clear photos of the frame from different angles. Skip lifestyle or worn photos if you can.
          </s-text>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: '8px' }}>
            {images.map((image) => {
              const isSelected = selected.includes(image.id)
              return (
                <button
                  key={image.id}
                  type="button"
                  aria-pressed={isSelected}
                  disabled={disabled}
                  onClick={() => onToggle(image.id)}
                  style={{
                    position: 'relative',
                    padding: 0,
                    background: 'transparent',
                    cursor: disabled ? 'default' : 'pointer',
                    borderRadius: '8px',
                    overflow: 'hidden',
                    border: isSelected ? '3px solid #005bd3' : '1px solid #c9cccf',
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
                        position: 'absolute',
                        top: '4px',
                        right: '4px',
                        width: '20px',
                        height: '20px',
                        lineHeight: '20px',
                        borderRadius: '50%',
                        background: '#005bd3',
                        color: '#fff',
                        fontSize: '13px',
                        textAlign: 'center',
                      }}
                    >
                      ✓
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          <s-text color="subdued">{selected.length} of 4 selected</s-text>
        </>
      )}
    </s-stack>
  )
}
