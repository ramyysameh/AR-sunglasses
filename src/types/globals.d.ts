/// <reference types="vite/client" />

/**
 * Optional runtime config injected by the Shopify theme / app embed. When present
 * it overrides the values baked in at build time (see `tryOnConfig.js`).
 */
interface ArTryOnConfig {
  defaultProvider?: string
  defaultSkuKey?: string
  camera?: { width?: number; height?: number }
  skus?: Record<string, unknown>
  [key: string]: unknown
}

interface Window {
  AR_TRYON_CONFIG?: ArTryOnConfig
}
