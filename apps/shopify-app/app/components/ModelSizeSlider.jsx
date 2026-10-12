/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */
import { useEffect, useRef, useState } from 'react'
import { useFetcher } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'
import {
  formatModelSize,
  MODEL_SIZE_DEFAULT,
  MODEL_SIZE_MAX,
  MODEL_SIZE_MIN,
  MODEL_SIZE_STEP,
  sizeToSubmit,
} from '../modelSize'

// "Size on face" slider for one Models card. A native range input, because
// Polaris web components have no slider.
//
// The readout follows the thumb live, but the value is saved once, when the
// merchant lets go: that is the native `change` event, attached by ref. React's
// onChange on a range input fires on every `input` event, which would post a
// save for every step the thumb passes. Posts intent=set-size to the current
// route's action; the loader revalidates afterwards, so `saved` catches up.
export default function ModelSizeSlider({ modelAssetId, modelName, saved = MODEL_SIZE_DEFAULT }) {
  const fetcher = useFetcher()
  const shopify = useAppBridge()
  const inputRef = useRef(null)
  const [value, setValue] = useState(saved)
  const { submit } = fetcher

  // Follow the server once a save lands (the loader revalidates)...
  useEffect(() => {
    setValue(saved)
  }, [saved])

  // ...and snap back to it if a save was refused. Only on a refusal: a success
  // can arrive before the revalidated `saved` does, and resetting then would
  // flick the thumb back to the old value for a moment.
  useEffect(() => {
    if (fetcher.data?.error) setValue(saved)
  }, [fetcher.data, saved])

  useEffect(() => {
    if (fetcher.data?.sizeSaved) shopify.toast.show('Size saved')
  }, [fetcher.data, shopify])

  useEffect(() => {
    const input = inputRef.current
    if (!input) return undefined
    const commit = () => {
      const size = sizeToSubmit(input.value, saved)
      if (size === null) return
      submit({ intent: 'set-size', modelAssetId, sizeMultiplier: String(size) }, { method: 'POST' })
    }
    input.addEventListener('change', commit)
    return () => input.removeEventListener('change', commit)
  }, [modelAssetId, saved, submit])

  const reset = () => {
    setValue(MODEL_SIZE_DEFAULT)
    submit(
      { intent: 'set-size', modelAssetId, sizeMultiplier: String(MODEL_SIZE_DEFAULT) },
      { method: 'POST' },
    )
  }

  return (
    <s-stack direction="block" gap="small-300">
      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small-300">
        <s-text type="strong">Size on face</s-text>
        <s-stack direction="inline" alignItems="center" gap="small-300">
          {saved !== MODEL_SIZE_DEFAULT && (
            <s-button
              variant="tertiary"
              accessibilityLabel={`Reset size for ${modelName}`}
              {...(fetcher.state !== 'idle' ? { disabled: true } : {})}
              onClick={reset}
            >
              Reset
            </s-button>
          )}
          <s-text fontVariantNumeric="tabular-nums">{formatModelSize(value)}</s-text>
        </s-stack>
      </s-stack>
      <input
        ref={inputRef}
        className="model-size-slider"
        type="range"
        min={MODEL_SIZE_MIN}
        max={MODEL_SIZE_MAX}
        step={MODEL_SIZE_STEP}
        value={value}
        aria-label={`Size on face for ${modelName}`}
        aria-valuetext={formatModelSize(value)}
        onChange={(event) => setValue(Number(event.currentTarget.value))}
      />
      {fetcher.data?.error ? (
        <s-text tone="critical">{fetcher.data.error}</s-text>
      ) : (
        <s-text color="subdued">1× is the automatic fit. Applies on top of Glasses size in your theme.</s-text>
      )}
    </s-stack>
  )
}
