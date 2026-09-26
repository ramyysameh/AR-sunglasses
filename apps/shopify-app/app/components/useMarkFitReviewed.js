import { useEffect } from 'react'
import { useFetcher } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'

// Shared by both "Review fit" dialogs (Workspace and Models). Posts to the
// current route's action, which handles intent=mark-fit-reviewed; the route's
// loader revalidates afterwards, so the status clears on its own.
export function useMarkFitReviewed(modalId) {
  const fetcher = useFetcher()
  const shopify = useAppBridge()

  useEffect(() => {
    if (!fetcher.data?.fitReviewed) return
    shopify.toast.show('Fit marked as reviewed')
    shopify.modal.hide(modalId)
  }, [fetcher.data, modalId, shopify])

  return {
    busy: fetcher.state !== 'idle',
    error: fetcher.data?.error ?? null,
    submit(modelAssetId) {
      if (!modelAssetId) return
      fetcher.submit({ intent: 'mark-fit-reviewed', modelAssetId }, { method: 'POST' })
    },
  }
}
