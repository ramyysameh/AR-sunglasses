import { defineConfig } from 'vite'

// NOTE ON WHAT IS DELIBERATELY NOT IMPORTED HERE.
//
// This config used to import ./src/config/arConfig.js to drive an authoring-
// model prune plugin. arConfig imports `three` at module top (its SKU catalog
// embeds THREE.Vector3 offsets), so loading this config pulled in `three` --
// and `vite build` failed on Vercel with ERR_MODULE_NOT_FOUND for `three`,
// resolving it from a temp config file where the monorepo's install did not
// surface it. Same failure class as basic-ssl below.
//
// The prune plugin was ALSO a no-op: it looked in `dist/models`, but this build
// overrides --outDir to apps/shopify-app/public/tryon, so its readdir always
// threw and it pruned nothing. So all ~66 MB of authoring models ship today
// regardless. Removing it is behaviour-preserving for the output and unblocks
// the deploy. A CORRECT, three-free prune belongs with the Phase 4 payload
// trimming -- do it there against the real outDir, and strip the `?v=` cache-
// buster getGlassesModelUrl appends before matching filenames.
//
// General rule this cost two failed deploys to learn: keep vite.config free of
// application runtime imports. Config load must not depend on packages that a
// production install might prune or fail to resolve.

export default defineConfig(async ({ command }) => {
  const plugins = []

  // basic-ssl serves the dev server over HTTPS so a phone can reach the camera
  // (getUserMedia needs a secure context). It is a dev-ONLY dependency and
  // Vercel's production install prunes it. Importing it at module top level made
  // `vite build` fail on deploy with ERR_MODULE_NOT_FOUND -- which is why the
  // try-on engine 404'd in production. Load it dynamically and only when
  // serving, so the build path never imports it and a pruned prod install is
  // harmless.
  if (command === 'serve') {
    const { default: basicSsl } = await import('@vitejs/plugin-basic-ssl')
    plugins.unshift(basicSsl())
  }

  return {
    plugins,
    server: {
      // Expose on the LAN over HTTPS so a phone on the same WiFi can reach the
      // camera. Open https://<pc-ip>:5173.
      host: true,
    },
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
  }
})
