import { useEffect, useRef } from 'react'
import { useFetcher, useLoaderData } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'
import { boundary } from '@shopify/shopify-app-react-router/server'
import { authenticate } from '../shopify.server'
import prisma from '../db.server'
import { saveCalibratedModel } from '../models.server'

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request)
  const assets = await prisma.modelAsset.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: 'desc' },
  })
  return { assets }
}

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request)
  const form = await request.formData()
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
  const { assets } = useLoaderData()
  const fetcher = useFetcher()
  const shopify = useAppBridge()
  const fileRef = useRef(null)
  const busy = fetcher.state !== 'idle'
  const up = fetcher.data?.uploaded
  const error = fetcher.data?.error

  useEffect(() => {
    if (up) shopify.toast.show('Model calibrated')
    if (error) shopify.toast.show(error, { isError: true })
  }, [up, error, shopify])

  const upload = () => {
    const file = fileRef.current?.files?.[0]
    if (!file) {
      shopify.toast.show('Choose a .glb file first', { isError: true })
      return
    }
    const fd = new FormData()
    fd.append('model', file)
    fetcher.submit(fd, { method: 'POST', encType: 'multipart/form-data' })
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
          <s-button onClick={upload} {...(busy ? { loading: true } : {})}>
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
        {error && (
          <s-box padding="base" borderWidth="base" borderRadius="base" background="critical">
            <s-paragraph>{error}</s-paragraph>
          </s-box>
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
