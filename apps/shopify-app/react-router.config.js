import { vercelPreset } from '@vercel/react-router/vite'

/**
 * The Vercel preset only engages when building on Vercel (it keys off the VERCEL
 * env var), so local `npm run build` + `react-router-serve` keep working unchanged
 * and `shopify app dev` is unaffected.
 *
 * @type {import('@react-router/dev/config').Config}
 */
export default {
  ssr: true,
  presets: process.env.VERCEL ? [vercelPreset()] : [],
}
