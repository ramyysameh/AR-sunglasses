import { useCallback, useEffect, useState } from 'react'
import { tryOnActiveFromExtensions } from '../workspaceState.js'

/**
 * Asks App Bridge whether the try-on embed is on in the published theme.
 * `shopify.app.extensions()` needs no access scopes and answers instantly, so
 * the setup step can tick itself off the moment the merchant comes back from
 * the theme editor instead of waiting for a shopper to load a product page.
 *
 * Re-checks whenever this tab regains focus or becomes visible (the merchant
 * saved the theme editor in another tab and switched back). Returns
 * { active, check }: active is true/false, or null when App Bridge could not
 * answer, in which case the caller keeps the loader's proof-of-life signal.
 * @param {any} shopify the useAppBridge() instance
 */
export function useEmbedActive(shopify) {
  const [active, setActive] = useState(null)

  const check = useCallback(async () => {
    try {
      const extensions = await shopify?.app?.extensions?.()
      const next = tryOnActiveFromExtensions(extensions)
      // Never forget a confirmed "on" because one later call failed.
      if (next !== null) setActive(next)
      return next
    } catch (error) {
      console.warn('app embed status unavailable', error)
      return null
    }
  }, [shopify])

  useEffect(() => {
    check()
    const onVisible = () => {
      if (document.visibilityState === 'visible') check()
    }
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [check])

  return { active, check }
}
