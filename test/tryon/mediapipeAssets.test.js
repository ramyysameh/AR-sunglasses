import { existsSync, readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { DEFAULT_MODEL_URL, DEFAULT_WASM_ROOT, MEDIAPIPE_VERSION } from '../../src/tracking/FaceTracker.js'
import { WASM_FILES } from '../../scripts/copy-mediapipe.mjs'

const root = new URL('../../', import.meta.url)
const installed = JSON.parse(readFileSync(new URL('node_modules/@mediapipe/tasks-vision/package.json', root), 'utf8')).version

describe('self-hosted MediaPipe assets', () => {
  it('loads face tracking from this origin, never a third-party CDN', () => {
    for (const url of [DEFAULT_MODEL_URL, DEFAULT_WASM_ROOT]) {
      expect(url.startsWith('/')).toBe(true)
      expect(url).not.toMatch(/googleapis|jsdelivr|https?:/)
    }
  })

  it('pins the wasm path to the installed @mediapipe/tasks-vision version', () => {
    // An upgrade without updating MEDIAPIPE_VERSION would point the engine at
    // a folder the copy script never created.
    expect(MEDIAPIPE_VERSION).toBe(installed)
    expect(DEFAULT_WASM_ROOT).toContain(`/mediapipe/${installed}/wasm`)
  })

  it('has the model file committed and every wasm file the resolver can ask for', () => {
    expect(existsSync(new URL('public' + DEFAULT_MODEL_URL, root))).toBe(true)
    for (const file of WASM_FILES) {
      expect(existsSync(new URL(`node_modules/@mediapipe/tasks-vision/wasm/${file}`, root))).toBe(true)
    }
  })
})
