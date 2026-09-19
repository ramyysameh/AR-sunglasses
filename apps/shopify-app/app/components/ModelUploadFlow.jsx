/* eslint-disable react/prop-types -- upload flow props are intentionally lightweight */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useRevalidator } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'

const MAX_UPLOAD_BYTES = 25 * 1048576
const UPLOAD_GUIDANCE = 'Choose a .glb file up to 25 MB.'

export function uploadValidationError(file) {
  if (!file || !file.name.toLowerCase().endsWith('.glb')) return UPLOAD_GUIDANCE
  if (file.size > MAX_UPLOAD_BYTES) return UPLOAD_GUIDANCE
  return null
}

export function normalizeUploadedAsset(uploaded) {
  const id = uploaded?.id ?? uploaded?.assetId
  if (!id) throw new Error('Uploaded model response is missing an asset id.')
  return { ...uploaded, id }
}

export function uploadModalReducer(state, action) {
  if (action.type === 'select') {
    return { pendingFile: action.file, uploadError: null }
  }
  if (action.type === 'reject') {
    return { ...state, uploadError: UPLOAD_GUIDANCE }
  }
  if (action.type === 'error') {
    return { ...state, uploadError: action.message }
  }
  return state
}

export function uploadModalHideBehavior(busy) {
  return busy
    ? { reopen: true, reset: false }
    : { reopen: false, reset: true }
}

export function createUploadCancellationCoordinator() {
  /** @type {{ controller: AbortController, xhr: XMLHttpRequest | null } | null} */
  // @ts-ignore -- the Shopify validator wraps this JS file as TSX and ignores JSDoc types.
  let activeUpload = null

  return {
    begin() {
      const controller = new AbortController()
      activeUpload = { controller, xhr: null }
      return controller.signal
    },
    attachXhr(xhr) {
      if (!activeUpload || activeUpload.controller.signal.aborted) {
        xhr.abort()
        return
      }
      activeUpload.xhr = xhr
    },
    detachXhr(xhr) {
      if (activeUpload?.xhr === xhr) activeUpload.xhr = null
    },
    abortForUnmount() {
      const upload = activeUpload
      activeUpload = null
      upload?.controller.abort()
      upload?.xhr?.abort()
    },
  }
}

function useModalEvents({ onAfterHide = undefined }) {
  const modalRef = useRef(null)

  useEffect(() => {
    const modal = modalRef.current
    if (!modal) return undefined
    if (onAfterHide) modal.addEventListener('afterhide', onAfterHide)
    return () => {
      if (onAfterHide) modal.removeEventListener('afterhide', onAfterHide)
    }
  }, [onAfterHide])

  return modalRef
}

async function postUploadJson(body, signal) {
  const res = await fetch('/api/model-upload', { method: 'POST', body, signal })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`Server error (HTTP ${res.status})`)
  }
  if (data.error) throw new Error(data.error)
  return data
}

// Pulled out of the useEffect below so the wiring itself -- "does a
// `droprejected` event on the element reach the reducer as a `reject`
// action" -- is unit-testable against a plain fake element (addEventListener/
// removeEventListener only), without needing a real DOM. This repo's test
// environment has no jsdom, so this is the closest thing to a behavioral test
// available for the fix without adding a new dependency: it proves the actual
// attach/detach logic, and combined with uploadModalReducer's existing
// 'reject' coverage, closes the loop through to the rendered "Choose a .glb
// file" banner text.
export function attachDropRejectedListener(dropZone, dispatchUpload) {
  const handleDropRejected = () => dispatchUpload({ type: 'reject' })
  dropZone.addEventListener('droprejected', handleDropRejected)
  return () => dropZone.removeEventListener('droprejected', handleDropRejected)
}

// Split out from UploadContent so the dropZoneRef wiring can be asserted
// structurally (the ref lands on the real <s-drop-zone>, and onDropRejected is
// genuinely gone, not just unused) without executing hooks outside of a
// render.
export function DropZoneField({ dropZoneRef, disabled, onInput }) {
  return (
    <s-drop-zone
      ref={dropZoneRef}
      label="Model file (.glb)"
      name="model"
      accept=".glb,model/gltf-binary"
      accessibilityLabel="Choose a GLB model file"
      disabled={disabled}
      // Not onChange: React 18's ChangeEventPlugin only special-cases a real
      // <select>/<input type=file> when deciding whether to dispatch a
      // synthetic `change` event -- s-drop-zone is a custom element, so
      // onChange here was silently never firing (a file chosen via the drop
      // zone never reached dispatchUpload). `input` is a simple,
      // type-agnostic DOM event React forwards regardless of tag name, and
      // Shopify's polaris-types IDL documents `oninput` for s-drop-zone
      // alongside `onchange` (polaris.d.ts:3880) -- see ModelPicker.jsx's
      // search field for the same reasoning already applied elsewhere.
      onInput={onInput}
      // `onDropRejected` is NOT wired here -- `dropRejected` is not in React
      // 18's simpleEventPluginEvents registry, so the prop is silently
      // stripped and the handler never runs. See attachDropRejectedListener
      // above and its useEffect call site for the real fix.
    ></s-drop-zone>
  )
}

function UploadContent({ cancellationCoordinator, embedded, onBusyChange, onUploaded }) {
  const shopify = useAppBridge()
  const revalidator = useRevalidator()
  const [{ pendingFile, uploadError }, dispatchUpload] = useReducer(uploadModalReducer, {
    pendingFile: null,
    uploadError: null,
  })
  const [progress, setProgress] = useState(null)
  const uploading = progress !== null
  const dropZoneRef = useRef(null)

  // `dropRejected` (fired when a dropped/chosen file fails the `accept`
  // filter) is not in React 18's simpleEventPluginEvents registry, so the
  // `onDropRejected` JSX prop this component used to carry was silently
  // stripped -- the handler never ran, and a merchant dropping a non-.glb file
  // got total silence instead of the "Choose a .glb file" banner. Confirmed
  // via @shopify/polaris-types/dist/polaris.d.ts:3881, which documents the
  // real IDL event as `ondroprejected` (i.e. the DOM event name is
  // `droprejected`). Wire it by hand, the same ref+addEventListener pattern as
  // useModalEvents above.
  useEffect(() => {
    const dropZone = dropZoneRef.current
    if (!dropZone) return undefined
    return attachDropRejectedListener(dropZone, dispatchUpload)
  }, [])

  const upload = async () => {
    const validationError = uploadValidationError(pendingFile)
    if (validationError) {
      dispatchUpload({ type: 'error', message: validationError })
      return
    }

    dispatchUpload({ type: 'select', file: pendingFile })
    onBusyChange(true)
    setProgress(0)
    const signal = cancellationCoordinator.begin()
    try {
      const presignForm = new FormData()
      presignForm.append('intent', 'upload-presign')
      const { uploadUrl, storageRef } = await postUploadJson(presignForm, signal)
      if (signal.aborted) return

      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        cancellationCoordinator.attachXhr(xhr)
        if (signal.aborted) {
          reject(new DOMException('Upload canceled', 'AbortError'))
          return
        }
        xhr.open('PUT', uploadUrl)
        xhr.setRequestHeader('Content-Type', 'model/gltf-binary')
        xhr.upload.onprogress = (event) => {
          if (!signal.aborted && event.lengthComputable) {
            setProgress(Math.round((event.loaded / event.total) * 100))
          }
        }
        xhr.onload = () => {
          cancellationCoordinator.detachXhr(xhr)
          if (xhr.status >= 200 && xhr.status < 300) resolve(undefined)
          else reject(new Error(`Upload failed (${xhr.status})`))
        }
        xhr.onerror = () => {
          cancellationCoordinator.detachXhr(xhr)
          reject(new Error('Upload failed (network/CORS)'))
        }
        xhr.onabort = () => reject(new DOMException('Upload canceled', 'AbortError'))
        xhr.send(pendingFile)
      })
      if (signal.aborted) return

      setProgress('preparing')
      const finalizeForm = new FormData()
      finalizeForm.append('intent', 'upload-finalize')
      finalizeForm.append('storageRef', storageRef)
      finalizeForm.append('filename', pendingFile.name)
      const { uploaded } = await postUploadJson(finalizeForm, signal)
      const asset = normalizeUploadedAsset(uploaded)
      if (!signal.aborted) {
        onUploaded?.(asset)
        shopify.toast.show('Model uploaded')
      }
      if (signal.aborted) return

      onBusyChange(false)
      setProgress(null)
      if (!embedded) shopify.modal.hide('upload-model')
      revalidator.revalidate()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!signal.aborted) dispatchUpload({ type: 'error', message })
    } finally {
      if (!signal.aborted) {
        onBusyChange(false)
        setProgress(null)
      }
    }
  }

  return (
    <>
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Choose a .glb eyewear model up to 25 MB. We&apos;ll prepare it for try-on.
        </s-paragraph>
        <DropZoneField
          dropZoneRef={dropZoneRef}
          disabled={uploading}
          onInput={(event) => {
            dispatchUpload({
              type: 'select',
              file: event.currentTarget.files?.[0] ?? null,
            })
          }}
        />
        {pendingFile && (
          <s-text color="subdued">
            {pendingFile.name} ({(pendingFile.size / 1048576).toFixed(1)} MB)
          </s-text>
        )}
        {progress !== null && (
          <s-stack direction="block" gap="small-500">
            {typeof progress === 'number' ? (
              <>
                <progress
                  aria-label="Model upload progress"
                  value={progress}
                  max="100"
                  style={{ width: '100%' }}
                />
                <s-text>Uploading {progress}%</s-text>
              </>
            ) : (
              <s-text>Preparing model...</s-text>
            )}
            <s-text color="subdued">Keep this window open while the model is uploading and preparing.</s-text>
          </s-stack>
        )}
        {uploadError && (
          <s-banner heading="Could not upload model" tone="critical">
            {uploadError}
          </s-banner>
        )}
      </s-stack>
      {!embedded && !uploading && (
        <s-button slot="secondary-actions" commandFor="upload-model" command="--hide">
          Cancel
        </s-button>
      )}
      {embedded ? (
        <s-button
          variant="primary"
          onClick={upload}
          disabled={!pendingFile || uploading}
          {...(uploading ? { loading: true } : {})}
        >
          Upload model
        </s-button>
      ) : (
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={upload}
          disabled={!pendingFile || uploading}
          {...(uploading ? { loading: true } : {})}
        >
          Upload model
        </s-button>
      )}
    </>
  )
}

export function ModelUploadFlow({
  onUploaded,
  triggerLabel = 'Upload model',
  triggerSlot,
  embedded = false,
}) {
  const shopify = useAppBridge()
  const [session, setSession] = useState(0)
  const busyRef = useRef(false)
  const cancellationCoordinator = useRef(null)
  if (!cancellationCoordinator.current) {
    cancellationCoordinator.current = createUploadCancellationCoordinator()
  }

  const onBusyChange = useCallback((busy) => {
    busyRef.current = busy
  }, [])
  const finishHide = useCallback(() => {
    const behavior = uploadModalHideBehavior(busyRef.current)
    if (behavior.reopen) {
      shopify.modal.show('upload-model')
    } else if (behavior.reset) {
      setSession((value) => value + 1)
    }
  }, [shopify])
  const modalRef = useModalEvents({ onAfterHide: embedded ? undefined : finishHide })

  useEffect(() => () => cancellationCoordinator.current.abortForUnmount(), [])

  const content = (
    <UploadContent
      key={session}
      cancellationCoordinator={cancellationCoordinator.current}
      embedded={embedded}
      onBusyChange={onBusyChange}
      onUploaded={onUploaded}
    />
  )

  if (embedded) return content

  return (
    <>
      <s-button
        {...(triggerSlot ? { slot: triggerSlot } : {})}
        commandFor="upload-model"
        command="--show"
      >
        {triggerLabel}
      </s-button>
      <s-modal ref={modalRef} id="upload-model" heading="Upload model">
        {content}
      </s-modal>
    </>
  )
}
