/**
 * Dev server for AR occlusion/fit testing.
 *
 * Adds two things the normal dev server cannot do:
 *
 *  1. A stub /api/register-model, so ?model=<local glb> exercises the REAL
 *     block-model path (validate -> normalize -> calibrate ->
 *     toEngineModelConfig -> registerRuntimeGlassesConfig) without the Shopify
 *     backend running.
 *
 *     It runs the SAME sequence as apps/shopify-app/app/calibration.server.js,
 *     deliberately: it used to call a bare calibrate() on the un-normalized
 *     doc, which meant every fit and occlusion number measured through this
 *     harness described a pipeline production does not run. Keep the two in
 *     step -- the whole value of this server is that what it measures is what
 *     ships. Production serves the merchant's original bytes, and so does the
 *     static handler here, so the delivery path now matches too.
 *
 *  2. Serves a denser, wider-range mock head over /mock-turn/frame-N.png. The
 *     repo's own turn frames peak at 26 degrees of yaw, which is not enough to
 *     expose the temple arm alongside the head -- the frontal mask still covers
 *     it there, so an occluder bug in that region is invisible. The replacement
 *     set sweeps +/-60 in 5 degree steps.
 *
 * Usage:
 *   npm run harness        -> http://localhost:5175  (Claude's in-app browser
 *                             refuses the dev server's self-signed cert, so the
 *                             plain-HTTP variant is the one that can be driven)
 *   npm run harness:https  -> https://<lan-ip>:5174 for phone testing, where
 *                             getUserMedia needs a secure context
 *
 * Mock assets live OUTSIDE the repo (they are ~13 MB of generated PNGs). Point
 * MOCK_HEAD_DIR at them; the default assumes the sibling layout this was built
 * with. Missing frames fall through to the repo's own, so the harness still runs
 * without them -- just with the 26-degree ceiling.
 */
import { defineConfig } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MOCK_HEAD_DIR = process.env.MOCK_HEAD_DIR
  ? path.resolve(process.env.MOCK_HEAD_DIR)
  : path.resolve(ROOT, '..', 'test-mock-head')
const SHOT_DIR = process.env.HARNESS_SHOT_DIR
  ? path.resolve(process.env.HARNESS_SHOT_DIR)
  : path.resolve(ROOT, '..', 'test-shots')
const HTTPS = process.env.HARNESS_HTTPS === '1'
const PORT = Number(process.env.HARNESS_PORT ?? (HTTPS ? 5174 : 5175))

const harnessPlugin = {
  name: 'ar-tryon-harness',
  configureServer(server) {
    // Registered in configureServer (not as a returned post-hook) so it runs
    // BEFORE vite's static handler and can shadow public/ without touching it.
    server.middlewares.use((req, res, next) => {
      const match = /^\/mock-turn\/(frame-\d+\.png)$/.exec((req.url ?? '').split('?')[0])
      if (!match) return next()
      const file = path.join(MOCK_HEAD_DIR, 'turn', match[1])
      if (!fs.existsSync(file)) return next()
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Cache-Control', 'no-store')
      res.end(fs.readFileSync(file))
    })

    // Screenshot sink. The agent driving this harness cannot see the preview
    // pane, and every geometry regression in this project's history reached the
    // user because automated runs could measure but not look. Posting composited
    // frames to disk closes that loop without a human in it.
    server.middlewares.use('/__shot', async (req, res) => {
      try {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const { name, dataUrl } = JSON.parse(Buffer.concat(chunks).toString())
        const safe = String(name ?? 'shot').replace(/[^a-zA-Z0-9._-]/g, '_')
        fs.mkdirSync(SHOT_DIR, { recursive: true })
        const file = path.join(SHOT_DIR, `${safe}.png`)
        fs.writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ file }))
      } catch (error) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(error?.message ?? error) }))
      }
    })

    server.middlewares.use('/api/register-model', async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost')
        const modelUrl = url.searchParams.get('url')
        if (!modelUrl) throw new Error('missing ?url')

        const { NodeIO } = await import('@gltf-transform/core')
        const { KHRONOS_EXTENSIONS } = await import('@gltf-transform/extensions')
        const { validateModel, normalizeModel, calibrate, MODELING_SPEC } =
          await import('@artryon/calibration')

        const rel = modelUrl.startsWith('/') ? modelUrl.slice(1) : modelUrl
        const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS)
        const doc = await io.read(path.join(ROOT, 'public', rel))

        const validation = validateModel(doc, MODELING_SPEC)
        if (validation.status === 'fail') {
          throw new Error(`model rejected: ${validation.issues.map((i) => i.message).join('; ')}`)
        }
        // normalizeModel mutates `doc`, which is fine: like production, this doc
        // is only ever measured, never written back.
        const { doc: measured, scale } = normalizeModel(doc, MODELING_SPEC)
        const { fitMetadata } = calibrate(measured, MODELING_SPEC, { modelScale: scale })

        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ fitMetadata, modelUrl }))
      } catch (error) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(error?.message ?? error) }))
      }
    })
  },
}

export default defineConfig(async () => {
  const plugins = [harnessPlugin]
  if (HTTPS) {
    // Loaded dynamically and only when asked for: basic-ssl is a dev-only
    // dependency that a production install prunes, and importing it at module
    // top level is what previously broke the Vercel build.
    const { default: basicSsl } = await import('@vitejs/plugin-basic-ssl')
    plugins.unshift(basicSsl())
  }

  return {
    root: ROOT,
    plugins,
    server: { host: true, port: PORT, strictPort: true },
  }
})
