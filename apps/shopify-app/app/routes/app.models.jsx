import { useEffect, useState } from 'react'
import { useFetcher, useLoaderData, useRevalidator } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'
import { boundary } from '@shopify/shopify-app-react-router/server'
import { authenticate } from '../shopify.server'
import prisma from '../db.server'
import { finalizeUpload, mapProductToModel, listMappings } from '../models.server'
import { presignModelUpload } from '../storage.server'
import { getActivePlanName, planLimit } from '../billing.server'
import { fetchProductsByIds } from '../products.server'
import ModelViewer from '../components/ModelViewer'

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request)
  // The app.jsx layout owns the no-subscription screen and hides this route's
  // content, so an unsubscribed shop must not reach the DB here -- and this
  // loader must NOT throw its own redirect (a /app/models -> /app -> /app loop
  // that renders a dead, control-less page: App Store rejection Ref 127328).
  // Return empty, do no gated work.
  const activePlan = await getActivePlanName(admin, session.shop)
  if (!activePlan) {
    return { assets: [], mappings: [] }
  }
  const [assets, mappings] = await Promise.all([
    prisma.modelAsset.findMany({ where: { shop: session.shop }, orderBy: { createdAt: 'desc' } }),
    listMappings(prisma, session.shop),
  ])
  let products = new Map()
  try {
    products = await fetchProductsByIds(admin, mappings.map((m) => m.productId))
  } catch (e) {
    // Enrichment only — a Shopify GraphQL failure must not take down the page.
    console.error('product enrichment failed', e)
  }
  const mappingsWithProduct = mappings.map((m) => ({ ...m, product: products.get(m.productId) ?? null }))
  return { assets, mappings: mappingsWithProduct }
}

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request)
  // Checked once up front (not just for new mappings): without this, a shop
  // with no subscription could still remap an already-mapped product, or
  // upload models, since those paths have no other billing check.
  const activePlan = await getActivePlanName(admin, session.shop)
  if (!activePlan) {
    return { error: 'No active subscription. Choose a plan to continue.' }
  }
  const form = await request.formData()
  const intent = form.get('intent')

  if (intent === 'map') {
    const productId = form.get('productId')?.toString().trim()
    const modelAssetId = form.get('modelAssetId')?.toString()
    if (!productId || !modelAssetId) {
      return { error: 'Enter a product ID and pick a model.' }
    }
    // Grandfather existing: only a genuinely NEW product counts against the cap.
    // mapProductToModel upserts on (shop, productId), so a re-map is not new.
    const existing = await prisma.productMapping.findUnique({
      where: { shop_productId: { shop: session.shop, productId } },
    })
    if (!existing) {
      const limit = planLimit(activePlan)
      const count = await prisma.productMapping.count({ where: { shop: session.shop } })
      if (count >= limit) {
        return {
          error:
            "You've reached your plan's product limit. Upgrade your plan to add try-on to more products.",
        }
      }
    }
    await mapProductToModel(prisma, session.shop, productId, modelAssetId)
    return { mapped: true }
  }

  if (intent === 'unmap') {
    const productId = form.get('productId')?.toString().trim()
    if (!productId) {
      return { error: 'Missing product to remove.' }
    }
    await prisma.productMapping.deleteMany({ where: { shop: session.shop, productId } })
    return { unmapped: true }
  }

  if (intent === 'upload-presign') {
    return await presignModelUpload()
  }

  if (intent === 'upload-finalize') {
    const storageRef = form.get('storageRef')?.toString()
    const filename = form.get('filename')?.toString() || null
    try {
      const uploaded = await finalizeUpload(prisma, session.shop, storageRef, filename)
      return { uploaded }
    } catch (e) {
      return { error: e.message }
    }
  }

  return { error: 'Unknown action.' }
}

// A human label for a model: its uploaded file name, with the upload date to
// disambiguate re-uploads of the same file. Falls back to a short id for older
// rows (and block-registered models) that predate the stored filename.
function modelName(a) {
  return a.filename || `Model ${a.id.slice(0, 8)}`
}
function modelLabel(a) {
  const when = a.createdAt
    ? new Date(a.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null
  return when ? `${modelName(a)} · ${when}` : modelName(a)
}

function sourceLabel(up) {
  if (up.source === 'tagged') return 'tagged (exact)'
  const pct = up.confidence == null ? '—' : `${Math.round(up.confidence * 100)}%`
  return `geometric (confidence ${pct})`
}

export default function Models() {
  const { assets, mappings } = useLoaderData()
  const mapFetcher = useFetcher()
  const unmapFetcher = useFetcher()
  const shopify = useAppBridge()
  const revalidator = useRevalidator()
  const [pendingFile, setPendingFile] = useState(null)
  const [picked, setPicked] = useState(null) // { id, title, imageUrl }
  const [modelAssetId, setModelAssetId] = useState('')
  const [progress, setProgress] = useState(null) // null | 0..100 | 'calibrating'
  const [uploadResult, setUploadResult] = useState(null)
  const [uploadErr, setUploadErr] = useState(null)
  const uploading = progress !== null
  const MAX_UPLOAD_BYTES = 25 * 1048576

  const mapping = mapFetcher.state !== 'idle'
  const mapError = mapFetcher.data?.error
  const mapped = mapFetcher.data?.mapped

  useEffect(() => {
    if (mapped) {
      shopify.toast.show('Product mapped')
      setPicked(null)
      setModelAssetId('')
    }
    if (mapError) shopify.toast.show(mapError, { isError: true })
  }, [mapped, mapError, shopify])

  const removeMapping = (productId) => unmapFetcher.submit({ intent: 'unmap', productId }, { method: 'POST' })
  useEffect(() => {
    if (unmapFetcher.data?.unmapped) shopify.toast.show('Mapping removed')
    if (unmapFetcher.data?.error) shopify.toast.show(unmapFetcher.data.error, { isError: true })
  }, [unmapFetcher.data, shopify])

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
      const presign = await fetch('/app/models', { method: 'POST', body: pf }).then((r) => r.json())
      if (presign.error) throw new Error(presign.error)
      const { uploadUrl, storageRef } = presign

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
      const fin = await fetch('/app/models', { method: 'POST', body: ff }).then((r) => r.json())
      if (fin.error) throw new Error(fin.error)

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

  const pickProduct = async () => {
    const selection = await shopify.resourcePicker({ type: 'product', action: 'select' })
    if (selection && selection[0]) {
      const p = selection[0]
      setPicked({ id: p.id, title: p.title, imageUrl: p.images?.[0]?.originalSrc ?? null })
    }
  }

  const submitMapping = () => {
    if (!picked?.id || !modelAssetId) {
      shopify.toast.show('Pick a product and a model first', { isError: true })
      return
    }
    mapFetcher.submit({ intent: 'map', productId: picked.id, modelAssetId }, { method: 'POST' })
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

      <s-section heading="Map a product to a model">
        {assets.length === 0 ? (
          <s-paragraph>Upload a model first, then map it to a product.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <s-paragraph>Select a product, then choose a model to map it to.</s-paragraph>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button onClick={pickProduct} icon="product">
                {picked ? 'Change product' : 'Select product'}
              </s-button>
              {picked && (
                <s-stack direction="inline" gap="small-500" alignItems="center">
                  {picked.imageUrl && (
                    <s-thumbnail src={picked.imageUrl} alt={picked.title} size="small"></s-thumbnail>
                  )}
                  <s-text type="strong">{picked.title}</s-text>
                </s-stack>
              )}
            </s-stack>
            <s-select
              label="Model"
              name="modelAssetId"
              value={modelAssetId}
              onChange={(e) => setModelAssetId(e.target.value)}
            >
              <s-option value="">Choose a model…</s-option>
              {assets.map((a) => (
                <s-option key={a.id} value={a.id}>
                  {modelLabel(a)}
                </s-option>
              ))}
            </s-select>
            <s-stack direction="inline" gap="base">
              <s-button variant="primary" onClick={submitMapping} {...(mapping ? { loading: true } : {})}>
                Map product
              </s-button>
            </s-stack>
            {mapError && <s-banner heading="Could not map" tone="critical">{mapError}</s-banner>}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Product mappings">
        {mappings.length === 0 ? (
          <s-stack direction="block" gap="base" alignItems="center">
            <s-text tone="subdued">No products mapped yet.</s-text>
            <s-paragraph>Upload a model, then map it to the product it belongs to.</s-paragraph>
          </s-stack>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header>Model status</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {mappings.map((m) => (
                <s-table-row key={m.id}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-500" alignItems="center">
                      {m.product?.imageUrl && (
                        <s-thumbnail src={m.product.imageUrl} alt={m.product.imageAlt ?? m.product.title} size="small"></s-thumbnail>
                      )}
                      <s-text type="strong">{m.product?.title ?? 'Product unavailable'}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={m.modelAsset.status === 'ready' ? 'success' : 'warning'}>
                      {m.modelAsset.status === 'ready' ? 'Calibrated' : 'Needs review'}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-button variant="tertiary" tone="critical" icon="delete" onClick={() => removeMapping(m.productId)}>
                      Remove
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Uploaded models">
        {assets.length === 0 ? (
          <s-stack direction="block" gap="base" alignItems="center">
            <s-text tone="subdued">No models yet.</s-text>
            <s-paragraph>Upload your first calibrated GLB above to get started.</s-paragraph>
          </s-stack>
        ) : (
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            {assets.map((a) => (
              <s-box key={a.id} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small-500">
                  <ModelViewer src={`/models/${a.id}.glb`} alt={modelName(a)} />
                  <s-text type="strong">{modelName(a)}</s-text>
                  <s-stack direction="inline" gap="small-500" alignItems="center">
                    <s-badge tone={a.status === 'ready' ? 'success' : 'warning'}>
                      {a.status === 'ready' ? 'Calibrated' : 'Needs review'}
                    </s-badge>
                    {a.confidence != null && <s-text tone="subdued">confidence {Math.round(a.confidence * 100)}%</s-text>}
                  </s-stack>
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
