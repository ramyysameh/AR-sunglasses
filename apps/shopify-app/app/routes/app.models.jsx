import { useEffect, useRef } from 'react'
import { useFetcher, useLoaderData } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'
import { boundary } from '@shopify/shopify-app-react-router/server'
import { authenticate } from '../shopify.server'
import prisma from '../db.server'
import { saveCalibratedModel, mapProductToModel, listMappings } from '../models.server'

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request)
  const [assets, mappings] = await Promise.all([
    prisma.modelAsset.findMany({ where: { shop: session.shop }, orderBy: { createdAt: 'desc' } }),
    listMappings(prisma, session.shop),
  ])
  return { assets, mappings }
}

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request)
  const form = await request.formData()
  const intent = form.get('intent')

  if (intent === 'map') {
    const productId = form.get('productId')?.toString().trim()
    const modelAssetId = form.get('modelAssetId')?.toString()
    if (!productId || !modelAssetId) {
      return { error: 'Enter a product ID and pick a model.' }
    }
    await mapProductToModel(prisma, session.shop, productId, modelAssetId)
    return { mapped: true }
  }

  const file = form.get('model')
  if (!file || typeof file === 'string') {
    return { error: 'Choose a .glb file to upload.' }
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  try {
    const uploaded = await saveCalibratedModel(prisma, session.shop, bytes)
    return { uploaded }
  } catch (e) {
    return { error: e.message }
  }
}

function sourceLabel(up) {
  if (up.source === 'tagged') return 'tagged (exact)'
  const pct = up.confidence == null ? '—' : `${Math.round(up.confidence * 100)}%`
  return `geometric (confidence ${pct})`
}

export default function Models() {
  const { assets, mappings } = useLoaderData()
  const uploadFetcher = useFetcher()
  const mapFetcher = useFetcher()
  const shopify = useAppBridge()
  const fileRef = useRef(null)
  const productRef = useRef(null)
  const modelRef = useRef(null)

  const uploading = uploadFetcher.state !== 'idle'
  const mapping = mapFetcher.state !== 'idle'
  const up = uploadFetcher.data?.uploaded
  const uploadError = uploadFetcher.data?.error
  const mapError = mapFetcher.data?.error
  const mapped = mapFetcher.data?.mapped

  useEffect(() => {
    if (up) shopify.toast.show('Model calibrated')
    if (uploadError) shopify.toast.show(uploadError, { isError: true })
  }, [up, uploadError, shopify])

  useEffect(() => {
    if (mapped) shopify.toast.show('Product mapped')
    if (mapError) shopify.toast.show(mapError, { isError: true })
  }, [mapped, mapError, shopify])

  const upload = () => {
    const file = fileRef.current?.files?.[0]
    if (!file) {
      shopify.toast.show('Choose a .glb file first', { isError: true })
      return
    }
    const fd = new FormData()
    fd.append('model', file)
    uploadFetcher.submit(fd, { method: 'POST', encType: 'multipart/form-data' })
  }

  const submitMapping = () => {
    const productId = productRef.current?.value?.trim()
    const modelAssetId = modelRef.current?.value
    if (!productId || !modelAssetId) {
      shopify.toast.show('Enter a product ID and pick a model', { isError: true })
      return
    }
    mapFetcher.submit({ intent: 'map', productId, modelAssetId }, { method: 'POST' })
  }

  return (
    <s-page heading="Models">
      <s-section heading="Upload a model (GLB)">
        <s-paragraph>
          Upload a calibrated eyewear GLB. It is validated and calibrated
          server-side by the A1 pipeline, and the normalized model is stored for
          try-on.
        </s-paragraph>
        <input ref={fileRef} type="file" accept=".glb,model/gltf-binary" />
        <s-stack direction="inline" gap="base">
          <s-button onClick={upload} {...(uploading ? { loading: true } : {})}>
            Upload &amp; calibrate
          </s-button>
        </s-stack>

        {up && (
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="small-500">
              <s-paragraph>Validation: {up.status}</s-paragraph>
              <s-paragraph>Fit: {sourceLabel(up)}</s-paragraph>
              <s-paragraph>Needs manual anchor: {up.needsManual ? 'yes' : 'no'}</s-paragraph>
              <s-text tone="subdued">Asset {up.assetId}</s-text>
            </s-stack>
          </s-box>
        )}
        {uploadError && (
          <s-box padding="base" borderWidth="base" borderRadius="base" background="critical">
            <s-paragraph>{uploadError}</s-paragraph>
          </s-box>
        )}
      </s-section>

      <s-section heading="Map a product to a model">
        {assets.length === 0 ? (
          <s-paragraph>Upload a model first, then map it to a product.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Enter a product ID (e.g. <s-text>gid://shopify/Product/123</s-text>) and choose a model.
            </s-paragraph>
            <input
              ref={productRef}
              type="text"
              placeholder="gid://shopify/Product/…"
              style={{ minWidth: '320px', padding: '4px' }}
            />
            <select ref={modelRef} style={{ padding: '4px' }}>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id} ({a.status})
                </option>
              ))}
            </select>
            <s-stack direction="inline" gap="base">
              <s-button onClick={submitMapping} {...(mapping ? { loading: true } : {})}>
                Map product
              </s-button>
            </s-stack>
            {mapError && (
              <s-box padding="base" borderWidth="base" borderRadius="base" background="critical">
                <s-paragraph>{mapError}</s-paragraph>
              </s-box>
            )}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Product mappings">
        {mappings.length === 0 ? (
          <s-paragraph>No products mapped yet.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {mappings.map((m) => (
              <s-box key={m.id} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small-500">
                  <s-text>{m.productId}</s-text>
                  <s-text tone="subdued">→ model {m.modelAssetId} ({m.modelAsset.status})</s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Uploaded models">
        {assets.length === 0 ? (
          <s-paragraph>No models yet.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {assets.map((a) => (
              <s-box key={a.id} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small-500">
                  <s-text>{a.id}</s-text>
                  <s-text tone="subdued">
                    status {a.status}
                    {a.confidence != null ? `, confidence ${Math.round(a.confidence * 100)}%` : ''}
                  </s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  )
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs)
}
