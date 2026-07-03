import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readdir, rm } from 'node:fs/promises'
import { defineConfig } from 'vite'
import { glassesConfig, getGlassesModelUrl } from './src/config/arConfig.js'

const rootDir = dirname(fileURLToPath(import.meta.url))

/**
 * The browser only ever downloads the Draco-compressed runtime models
 * (see `getGlassesModelUrl`). The full-precision authoring assets — raw source
 * GLBs, *-opt and normalized variants — live in `public/models` so the Node
 * tooling (normalize/inspect/validate) can use them, but they must NOT ship to
 * production. This plugin prunes every model from the build output except the
 * runtime files the SKU catalog actually references.
 */
function pruneAuthoringModels() {
  return {
    name: 'prune-authoring-models',
    apply: 'build',
    async closeBundle() {
      const distModelsDir = resolve(rootDir, 'dist/models')
      const runtimeFiles = new Set(
        Object.keys(glassesConfig).map((key) => getGlassesModelUrl(key).replace(/^models\//, ''))
      )

      let entries
      try {
        entries = await readdir(distModelsDir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        const keep = entry.isFile() && runtimeFiles.has(entry.name)
        if (!keep) {
          await rm(resolve(distModelsDir, entry.name), { recursive: true, force: true })
        }
      }
    },
  }
}

export default defineConfig({
  plugins: [pruneAuthoringModels()],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        calibrate: 'harness/calibrate.html',
      },
      output: {
        manualChunks: {
          three: ['three'],
          mediapipe: ['@mediapipe/tasks-vision'],
        },
      },
    },
  },
})
