import { useEffect, useState } from 'react'
import { useFetcher, useLoaderData, useRevalidator } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'
import { boundary } from '@shopify/shopify-app-react-router/server'
import { authenticate } from '../shopify.server'
import prisma from '../db.server'
import { getActivePlanName } from '../billing.server'
import { deleteModelGlb } from '../storage.server'
import ModelViewer from '../components/ModelViewer'

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request)
  // app.jsx owns the no-subscription screen; this loader must NOT redirect
  // (App Store rejection Ref 127328).
  const activePlan = await getActivePlanName(admin, session.shop)
  if (!activePlan) {
    return { assets: [] }
  }
  const assets = await prisma.modelAsset.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { mappings: true } } },
  })
  return {
    assets: assets.map(({ _count, ...a }) => ({ ...a, mappingCount: _count.mappings })),
  }
}

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request)
  const activePlan = await getActivePlanName(admin, session.shop)
  if (!activePlan) {
    return { error: 'No active subscription. Choose a plan to continue.' }
  }
  const form = await request.formData()
  const intent = form.get('intent')

  if (intent === 'rename') {
    const id = form.get('modelAssetId')?.toString()
    const label = form.get('label')?.toString().trim()
    if (!id) return { error: 'Missing model.' }
    // Scoped to the shop: an id from another shop must not be renamable.
    const { count } = await prisma.modelAsset.updateMany({
      where: { id, shop: session.shop },
      data: { label: label || null },
    })
    if (count === 0) return { error: 'That model no longer exists.' }
    return { renamed: true }
  }

  if (intent === 'delete') {
    const id = form.get('modelAssetId')?.toString()
    if (!id) return { error: 'Missing model.' }
    const asset = await prisma.modelAsset.findFirst({
      where: { id, shop: session.shop },
      include: { _count: { select: { mappings: true } } },
    })
    if (!asset) return { error: 'That model no longer exists.' }
    // The FK is ON DELETE RESTRICT, so deleting a mapped model would throw a
    // raw Prisma error. Refuse with something a merchant can act on instead.
    if (asset._count.mappings > 0) {
      return { error: `That model is used by ${asset._count.mappings} product(s). Remove try-on from them first.` }
    }
    await prisma.modelAsset.delete({ where: { id: asset.id } })
    try {
      await deleteModelGlb(asset.storageRef)
    } catch (e) {
      // The row is gone, which is what the merchant asked for. A stranded
      // object is a storage cost, not a user-visible failure.
      console.error('model GLB delete failed', e)
    }
    return { deleted: true }
  }

  // Model upload (presign/finalize) lives in the api.model-upload resource
  // route: a raw fetch() POST here returns the rendered HTML document instead
  // of JSON. See app/routes/api.model-upload.jsx.
  return { error: 'Unknown action.' }
}

// A human label for a model: its uploaded file name. Falls back to a short id
// for older rows (and block-registered models) that predate the stored
// filename.
function modelName(a) {
  return a.filename || `Model ${a.id.slice(0, 8)}`
}

function sourceLabel(up) {
  if (up.source === 'tagged') return 'tagged (exact)'
  const pct = up.confidence == null ? '—' : `${Math.round(up.confidence * 100)}%`
  return `geometric (confidence ${pct})`
}

export default function Models() {
  const { assets } = useLoaderData()
  const shopify = useAppBridge()
  const revalidator = useRevalidator()
  const [pendingFile, setPendingFile] = useState(null)
  const [progress, setProgress] = useState(null) // null | 0..100 | 'calibrating'
  const [uploadResult, setUploadResult] = useState(null)
  const [uploadErr, setUploadErr] = useState(null)
  const uploading = progress !== null
  const MAX_UPLOAD_BYTES = 25 * 1048576

  const manageFetcher = useFetcher()
  const rename = (modelAssetId, label) =>
    manageFetcher.submit({ intent: 'rename', modelAssetId, label }, { method: 'POST' })
  const remove = (modelAssetId) =>
    manageFetcher.submit({ intent: 'delete', modelAssetId }, { method: 'POST' })

  useEffect(() => {
    if (manageFetcher.data?.renamed) shopify.toast.show('Name saved')
    if (manageFetcher.data?.deleted) shopify.toast.show('Model deleted')
    if (manageFetcher.data?.error) shopify.toast.show(manageFetcher.data.error, { isError: true })
  }, [manageFetcher.data, shopify])

  // POST to the resource route and parse JSON defensively: a non-JSON body
  // (an error page, an auth bounce) becomes a clear message instead of the
  // opaque "Unexpected token '<'" a bare response.json() throws on HTML.
  const postJson = async (body) => {
    const res = await fetch('/api/model-upload', { method: 'POST', body })
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

  const upload = async () => {
    if (!pendingFile) {
      shopify.toast.show('Choose a .glb file first', { isError: true }); return
    }
    if (!pendingFile.name.toLowerCase().endsWith('.glb')) {
      shopify.toast.show('Choose a .glb file', { isError: true }); return
    }
    if (pendingFile.size > MAX_UPLOAD_BYTES) {
      shopify.toast.show('Model exceeds the 25 MB limit', { isError: true }); return
    }
    setUploadErr(null); setUploadResult(null); setProgress(0)
    try {
      // 1) presign
      const pf = new FormData(); pf.append('intent', 'upload-presign')
      const { uploadUrl, storageRef } = await postJson(pf)

      // 2) direct PUT with progress (XHR — fetch can't report upload progress)
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('PUT', uploadUrl)
        xhr.setRequestHeader('Content-Type', 'model/gltf-binary')
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100))
        }
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(new Error(`Upload failed (${xhr.status})`))
        xhr.onerror = () => reject(new Error('Upload failed (network/CORS)'))
        xhr.send(pendingFile)
      })

      // 3) finalize (calibrate server-side)
      setProgress('calibrating')
      const ff = new FormData()
      ff.append('intent', 'upload-finalize')
      ff.append('storageRef', storageRef)
      ff.append('filename', pendingFile.name)
      const fin = await postJson(ff)

      setUploadResult(fin.uploaded)
      shopify.toast.show('Model calibrated')
      revalidator.revalidate() // refresh the model list (no fetcher to auto-revalidate now)
    } catch (e) {
      setUploadErr(e.message)
      shopify.toast.show(e.message, { isError: true })
    } finally {
      setProgress(null)
    }
  }

  return (
    <s-page heading="Models">
      <s-section heading="Upload a model (GLB)">
        <s-paragraph>
          Upload a calibrated eyewear GLB. It is validated and calibrated
          server-side by the A1 pipeline, and the normalized model is stored for
          try-on.
        </s-paragraph>
        <s-drop-zone
          label="Model file (.glb)"
          name="model"
          accept=".glb,model/gltf-binary"
          onChange={(e) => setPendingFile(e.currentTarget.files?.[0] ?? null)}
        ></s-drop-zone>
        {pendingFile && (
          <s-banner tone="info">
            Selected: {pendingFile.name} ({(pendingFile.size / 1048576).toFixed(1)} MB)
          </s-banner>
        )}
        <s-stack direction="inline" gap="base">
          <s-button variant="primary" onClick={upload} {...(uploading ? { loading: true } : {})}>
            Upload and calibrate
          </s-button>
        </s-stack>

        {progress !== null && (
          <s-stack direction="block" gap="small-500">
            {typeof progress === 'number' ? (
              <>
                <progress value={progress} max="100" style={{ width: '100%' }} />
                <s-text>Uploading… {progress}%</s-text>
              </>
            ) : (
              <s-text>Calibrating…</s-text>
            )}
          </s-stack>
        )}

        {uploadResult && (
          <s-banner heading="Model calibrated" tone="success">
            <s-stack direction="block" gap="small-500">
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-text>Validation</s-text>
                <s-badge tone="success">{uploadResult.status}</s-badge>
              </s-stack>
              <s-text>Fit: {sourceLabel(uploadResult)}</s-text>
              {uploadResult.needsManual && <s-badge tone="warning">Needs manual anchor</s-badge>}
            </s-stack>
          </s-banner>
        )}
        {uploadErr && <s-banner heading="Upload failed" tone="critical">{uploadErr}</s-banner>}
      </s-section>

      <s-section heading="Your models">
        {assets.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-text type="strong">Upload your first model</s-text>
            <s-paragraph>Add a .glb of your frames above to get started.</s-paragraph>
          </s-stack>
        ) : (
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            {assets.map((a) => (
              <s-box key={a.id} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small-500">
                  <ModelViewer src={`/models/${a.id}.glb`} alt={modelName(a)} />
                  <s-text-field
                    label="Name"
                    value={a.label ?? ''}
                    placeholder={a.filename ?? `Model ${a.id.slice(0, 8)}`}
                    onBlur={(e) => rename(a.id, e.currentTarget.value)}
                  ></s-text-field>
                  <s-stack direction="inline" gap="small-500" alignItems="center">
                    <s-badge tone={a.status === 'ready' ? 'success' : 'warning'}>
                      {a.status === 'ready' ? 'Ready' : 'Check fit'}
                    </s-badge>
                    {a.confidence != null && (
                      <s-text tone="subdued">fit confidence {Math.round(a.confidence * 100)}%</s-text>
                    )}
                  </s-stack>
                  {a.mappingCount > 0 ? (
                    <s-text tone="subdued">
                      Used by {a.mappingCount} product{a.mappingCount === 1 ? '' : 's'} --{' '}
                      <s-link href="/app/products">view</s-link>
                    </s-text>
                  ) : (
                    <s-button variant="tertiary" tone="critical" icon="delete" onClick={() => remove(a.id)}>
                      Delete
                    </s-button>
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-grid>
        )}
      </s-section>
    </s-page>
  )
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs)
}
