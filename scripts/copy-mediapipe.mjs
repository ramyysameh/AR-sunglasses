// Copies MediaPipe's WebAssembly runtime out of node_modules into public/ so
// the engine serves it from its own origin instead of cdn.jsdelivr.net. The
// shopper's browser then talks to no third party for face tracking (see the
// privacy policy), and a jsDelivr outage can no longer break the try-on.
//
// Only the two non-module variants FilesetResolver.forVisionTasks() picks
// between (SIMD and no-SIMD) are copied. The destination is versioned so an
// upgrade never serves a stale runtime; src/tracking/FaceTracker.js must name
// the same version (test/tryon/mediapipeAssets.test.js checks both).
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = join(root, 'node_modules', '@mediapipe', 'tasks-vision')
const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))

export const WASM_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
]

export function copyMediapipeWasm() {
  const dest = join(root, 'public', 'mediapipe', version, 'wasm')
  mkdirSync(dest, { recursive: true })
  for (const file of WASM_FILES) {
    copyFileSync(join(pkgDir, 'wasm', file), join(dest, file))
  }
  return dest
}

// Run only when invoked as a script, so tests can import WASM_FILES.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`copied MediaPipe ${version} wasm to ${copyMediapipeWasm()}`)
}
