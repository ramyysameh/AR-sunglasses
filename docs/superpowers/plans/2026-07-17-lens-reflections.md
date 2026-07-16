# Lens Reflections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give sunglasses lenses a soft sky reflection plus a sun glint that sweeps across as the user turns their head, without touching the frame's appearance.

**Architecture:** A procedural equirectangular sky (gradient + sun disc) is computed as raw linear-radiance pixels, wrapped in a `DataTexture`, PMREM-prefiltered once at startup, and assigned as `envMap` on **lens materials only**. `scene.environment` is never set, so no frame material can receive it. The sweep needs no animation code: the env map is world-fixed while `glassesRoot` rotates with the head, so the reflection vector changes per-frame on its own.

**Tech Stack:** three.js `0.184.0` (`DataTexture`, `PMREMGenerator`), vitest (`environment: 'node'`), vanilla ES modules.

**Spec:** `docs/superpowers/specs/2026-07-17-lens-reflections-design.md`

## Global Constraints

- **Linear radiance only.** `createSkyPixels` emits linear values, never gamma-encoded. `sunIntensity` is a linear multiplier and **may exceed 1.0** — that is intended, not a bug.
- **The `DataTexture` MUST be tagged `THREE.LinearSRGBColorSpace`.** It defaults to `NoColorSpace`; leaving it unset silently decouples rendered sun brightness from `sunIntensity`, and that failure looks identical to "intensity needs tuning".
- **Never assign `scene.environment`.** Lens materials get `material.envMap` individually. This is what structurally protects the frame from the glare regression fixed in `2e12c0f`.
- **`dispose()` frees all three GPU resources:** source `DataTexture`, the `WebGLRenderTarget` from `fromEquirectangular()`, and the `PMREMGenerator`.
- **No DOM in `skyTexture.js`.** No canvas, no `window`. Tests run under `environment: 'node'`.
- Baked defaults: `intensity 1.8`, `roughness 0.06`, `sunAzimuthDeg 35`, `sunElevationDeg 28`. These are starting points to be tuned on-device and re-baked.
- Run tests with `npx vitest run test/tryon`.

## File Structure

| File | Responsibility |
|---|---|
| `src/core/skyTexture.js` (new) | Pure pixel math. Equirect sky gradient + sun disc → `Float32Array`. No DOM, no three. |
| `src/core/lensReflection.js` (new) | URL param resolution + applying reflection to a material (envMap, intensity, roughness clamp). |
| `src/core/lensEnvironment.js` (new) | `DataTexture` + PMREM wrapper. The only GPU-touching piece. |
| `src/core/RenderLoop.js` (modify) | Builds the env map once in `init()`; new `dispose()` frees it. |
| `src/models/GlassesModelLoader.js` (modify) | Applies reflection at its two existing lens branches. |
| `src/tryon/providers/MediaPipeThreeProvider.js` (modify) | Passes env map to loader; calls `renderLoop.dispose()` in `destroy()`. |

---

### Task 1: Procedural sky pixels

**Files:**
- Create: `src/core/skyTexture.js`
- Test: `test/tryon/skyTexture.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `createSkyPixels({ width, height, sunAzimuthDeg, sunElevationDeg, sunSizeDeg, sunIntensity }) -> Float32Array` (RGBA, length `width * height * 4`, linear radiance).

**Pixel mapping contract** (later tasks and tests depend on it exactly):
- `u = (x + 0.5) / width`, `azimuth = u * 360 - 180` (degrees, so `u=0.5` → azimuth `0`)
- `v = (y + 0.5) / height`, `elevation = 90 - v * 180` (degrees, so `y=0` is straight up)

- [ ] **Step 1: Write the failing test**

Create `test/tryon/skyTexture.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { createSkyPixels } from '../../src/core/skyTexture.js'

const WIDTH = 128
const HEIGHT = 64

function luminanceAt(pixels, x, y, width = WIDTH) {
  const i = (y * width + x) * 4
  return 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]
}

function brightestPixel(pixels, width = WIDTH, height = HEIGHT) {
  let best = { x: 0, y: 0, lum: -Infinity }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const lum = luminanceAt(pixels, x, y, width)
      if (lum > best.lum) best = { x, y, lum }
    }
  }
  return best
}

describe('createSkyPixels', () => {
  it('returns an RGBA buffer of the requested size with opaque alpha', () => {
    const pixels = createSkyPixels({ width: WIDTH, height: HEIGHT })
    expect(pixels).toBeInstanceOf(Float32Array)
    expect(pixels.length).toBe(WIDTH * HEIGHT * 4)
    for (let i = 3; i < pixels.length; i += 4) {
      expect(pixels[i]).toBe(1)
    }
  })

  it('puts the sun at the requested azimuth and elevation', () => {
    const pixels = createSkyPixels({
      width: WIDTH,
      height: HEIGHT,
      sunAzimuthDeg: 35,
      sunElevationDeg: 28,
    })
    const { x, y } = brightestPixel(pixels)
    const azimuth = ((x + 0.5) / WIDTH) * 360 - 180
    const elevation = 90 - ((y + 0.5) / HEIGHT) * 180
    // One pixel spans ~2.8deg, so allow a pixel of slack in each axis.
    expect(Math.abs(azimuth - 35)).toBeLessThan(3)
    expect(Math.abs(elevation - 28)).toBeLessThan(3)
  })

  it('emits linear radiance above 1.0 for a bright sun (no gamma, no clamp)', () => {
    const pixels = createSkyPixels({
      width: WIDTH,
      height: HEIGHT,
      sunIntensity: 14,
    })
    expect(brightestPixel(pixels).lum).toBeGreaterThan(1)
  })

  it('falls off smoothly from the sun centre instead of hard-clipping', () => {
    const pixels = createSkyPixels({
      width: WIDTH,
      height: HEIGHT,
      sunAzimuthDeg: 0,
      sunElevationDeg: 0,
      sunSizeDeg: 20,
    })
    // Azimuth 0 / elevation 0 sits mid-row, mid-column. Walk outward along the row.
    const y = Math.floor(HEIGHT / 2)
    const centreX = Math.floor(WIDTH / 2)
    let previous = Infinity
    for (let step = 0; step < 8; step++) {
      const lum = luminanceAt(pixels, centreX + step, y)
      expect(lum).toBeLessThan(previous)
      previous = lum
    }
  })

  it('gradates monotonically from the sky top down to the horizon', () => {
    const pixels = createSkyPixels({
      width: WIDTH,
      height: HEIGHT,
      sunAzimuthDeg: 35,
      sunElevationDeg: 28,
    })
    // Sample the column opposite the sun so the disc cannot contaminate it.
    const x = Math.floor(((-145 + 180) / 360) * WIDTH)
    let previous = -Infinity
    for (let y = 0; y <= HEIGHT / 2; y++) {
      const lum = luminanceAt(pixels, x, y)
      expect(lum).toBeGreaterThan(previous)
      previous = lum
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tryon/skyTexture.test.js`
Expected: FAIL — `Failed to resolve import "../../src/core/skyTexture.js"`

- [ ] **Step 3: Write minimal implementation**

Create `src/core/skyTexture.js`:

```js
/**
 * Procedural sky for lens reflections: a vertical gradient with a sun disc,
 * as raw equirectangular pixels.
 *
 * Values are LINEAR radiance, never gamma-encoded — PMREMGenerator expects
 * linear input, so sunIntensity is a linear multiplier and may exceed 1.
 *
 * Deliberately no canvas and no DOM: pure pixel math, so it runs in Node.
 */

// Linear radiance. Horizon is the bright band; sky darkens upward, ground
// darkens downward.
const SKY_TOP = [0.10, 0.22, 0.48]
const HORIZON = [0.72, 0.80, 0.92]
const GROUND = [0.09, 0.08, 0.07]

const DEG = Math.PI / 180

function directionFromAngles(azimuthDeg, elevationDeg) {
  const azimuth = azimuthDeg * DEG
  const elevation = elevationDeg * DEG
  const cosElevation = Math.cos(elevation)
  return [
    Math.sin(azimuth) * cosElevation,
    Math.sin(elevation),
    Math.cos(azimuth) * cosElevation,
  ]
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

export function createSkyPixels({
  width = 128,
  height = 64,
  sunAzimuthDeg = 35,
  sunElevationDeg = 28,
  sunSizeDeg = 9,
  sunIntensity = 14,
} = {}) {
  const pixels = new Float32Array(width * height * 4)
  const sun = directionFromAngles(sunAzimuthDeg, sunElevationDeg)

  for (let y = 0; y < height; y++) {
    const elevation = 90 - ((y + 0.5) / height) * 180
    const gradientT = Math.abs(elevation) / 90
    const target = elevation >= 0 ? SKY_TOP : GROUND
    const r = HORIZON[0] + (target[0] - HORIZON[0]) * gradientT
    const g = HORIZON[1] + (target[1] - HORIZON[1]) * gradientT
    const b = HORIZON[2] + (target[2] - HORIZON[2]) * gradientT

    for (let x = 0; x < width; x++) {
      const azimuth = ((x + 0.5) / width) * 360 - 180
      const direction = directionFromAngles(azimuth, elevation)

      const cosAngle = direction[0] * sun[0] + direction[1] * sun[1] + direction[2] * sun[2]
      const angleDeg = Math.acos(Math.min(Math.max(cosAngle, -1), 1)) / DEG
      // 1 at the sun centre, 0 at its edge. Squared so the core stays hot but
      // the rim blooms instead of hard-clipping into an aliased dot.
      const falloff = smoothstep(sunSizeDeg, 0, angleDeg)
      const sunAdd = sunIntensity * falloff * falloff

      const i = (y * width + x) * 4
      pixels[i] = r + sunAdd
      pixels[i + 1] = g + sunAdd
      pixels[i + 2] = b + sunAdd
      pixels[i + 3] = 1
    }
  }

  return pixels
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tryon/skyTexture.test.js`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/skyTexture.js test/tryon/skyTexture.test.js
git commit -m "feat(engine): procedural sky pixels for lens reflections"
```

---

### Task 2: Reflection config and material application

**Files:**
- Create: `src/core/lensReflection.js`
- Test: `test/tryon/lensReflection.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `resolveLensReflectionConfig(search) -> { intensity, roughness, sunAzimuthDeg, sunElevationDeg }`
  - `applyLensReflection(material, envMap, config) -> void`

`applyLensReflection` is the single place the roughness clamp lives, shared by both of `GlassesModelLoader`'s lens branches (Task 4) so the rule is not duplicated.

- [ ] **Step 1: Write the failing test**

Create `test/tryon/lensReflection.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { resolveLensReflectionConfig, applyLensReflection } from '../../src/core/lensReflection.js'

describe('resolveLensReflectionConfig', () => {
  it('defaults to the baked device-tuned values', () => {
    const config = resolveLensReflectionConfig('')
    expect(config.intensity).toBeCloseTo(1.8)
    expect(config.roughness).toBeCloseTo(0.06)
    expect(config.sunAzimuthDeg).toBeCloseTo(35)
    expect(config.sunElevationDeg).toBeCloseTo(28)
  })

  it('honours every override', () => {
    const config = resolveLensReflectionConfig('?lensrefl=2.5&lensrough=0.2&sunaz=-90&sunel=60')
    expect(config.intensity).toBeCloseTo(2.5)
    expect(config.roughness).toBeCloseTo(0.2)
    expect(config.sunAzimuthDeg).toBeCloseTo(-90)
    expect(config.sunElevationDeg).toBeCloseTo(60)
  })

  it('ignores non-numeric and out-of-range values', () => {
    const config = resolveLensReflectionConfig('?lensrefl=abc&lensrough=5&sunel=400')
    expect(config.intensity).toBeCloseTo(1.8)
    expect(config.roughness).toBeCloseTo(0.06)
    expect(config.sunElevationDeg).toBeCloseTo(28)
  })

  it('allows a zero intensity so reflections can be switched off for comparison', () => {
    expect(resolveLensReflectionConfig('?lensrefl=0').intensity).toBe(0)
  })
})

describe('applyLensReflection', () => {
  const config = { intensity: 1.8, roughness: 0.06, sunAzimuthDeg: 35, sunElevationDeg: 28 }
  const envMap = { name: 'env' }

  it('assigns the env map and intensity', () => {
    const material = { roughness: 0.5 }
    applyLensReflection(material, envMap, config)
    expect(material.envMap).toBe(envMap)
    expect(material.envMapIntensity).toBeCloseTo(1.8)
  })

  it('clamps a mirror-smooth authored lens up to the roughness floor', () => {
    // Smoke_Lens in gripzpelmo.glb is authored at roughness 0; at true zero the
    // sun reflects as a hard aliased dot.
    const material = { roughness: 0 }
    applyLensReflection(material, envMap, config)
    expect(material.roughness).toBeCloseTo(0.06)
  })

  it('leaves a rougher authored lens alone', () => {
    const material = { roughness: 0.3 }
    applyLensReflection(material, envMap, config)
    expect(material.roughness).toBeCloseTo(0.3)
  })

  it('does nothing without an env map', () => {
    const material = { roughness: 0 }
    applyLensReflection(material, null, config)
    expect(material.envMap).toBeUndefined()
    expect(material.roughness).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tryon/lensReflection.test.js`
Expected: FAIL — `Failed to resolve import "../../src/core/lensReflection.js"`

- [ ] **Step 3: Write minimal implementation**

Create `src/core/lensReflection.js`:

```js
// Lens reflection tuning. Defaults are baked from on-device tuning; the URL
// params exist to re-tune on a real phone, exactly like ?gscale and ?voffset.
const DEFAULTS = {
  // Above 1 on purpose: the loader forces lens opacity to ~0.62 and alpha
  // blending scales the whole fragment, so intensity 1 arrives pre-dimmed.
  intensity: 1.8,
  // Roughness floor. Smoke_Lens is authored at 0 (perfect mirror), which makes
  // the sun a hard aliased dot; a little roughness blooms it into a glint.
  roughness: 0.06,
  sunAzimuthDeg: 35,
  sunElevationDeg: 28,
}

function resolveParam(search, key, fallback, isValid) {
  const raw = parseFloat(new URLSearchParams(search).get(key))
  return Number.isFinite(raw) && isValid(raw) ? raw : fallback
}

export function resolveLensReflectionConfig(search) {
  return {
    intensity: resolveParam(search, 'lensrefl', DEFAULTS.intensity, (v) => v >= 0),
    roughness: resolveParam(search, 'lensrough', DEFAULTS.roughness, (v) => v >= 0 && v <= 1),
    sunAzimuthDeg: resolveParam(search, 'sunaz', DEFAULTS.sunAzimuthDeg, () => true),
    sunElevationDeg: resolveParam(search, 'sunel', DEFAULTS.sunElevationDeg, (v) => v >= -90 && v <= 90),
  }
}

/**
 * Applies the reflection to ONE lens material. Never call this for a frame
 * material: the frame is deliberately excluded (see 2e12c0f — glossy frame
 * specular read as a distracting white glare).
 */
export function applyLensReflection(material, envMap, config) {
  if (!material || !envMap) {
    return
  }

  material.envMap = envMap
  material.envMapIntensity = config.intensity

  if ('roughness' in material && material.roughness < config.roughness) {
    material.roughness = config.roughness
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tryon/lensReflection.test.js`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/lensReflection.js test/tryon/lensReflection.test.js
git commit -m "feat(engine): lens reflection config + material application"
```

---

### Task 3: PMREM environment wrapper

**Files:**
- Create: `src/core/lensEnvironment.js`
- Test: `test/tryon/lensEnvironment.test.js`

**Interfaces:**
- Consumes: `createSkyPixels` from Task 1.
- Produces: `createLensEnvironment(renderer, options) -> { texture, dispose }`, where `options` accepts `sunAzimuthDeg` and `sunElevationDeg` and is forwarded to `createSkyPixels`.

`PMREMGenerator` needs a real GL context, so the test mocks it. Everything else (`DataTexture`) is the real three class and works in Node.

- [ ] **Step 1: Write the failing test**

Create `test/tryon/lensEnvironment.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as THREE from 'three'

const hoisted = vi.hoisted(() => ({ disposed: [], source: null }))

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal()
  class FakePMREMGenerator {
    compileEquirectangularShader() {}
    fromEquirectangular(source) {
      hoisted.source = source
      return {
        texture: { name: 'prefiltered-env' },
        dispose: () => hoisted.disposed.push('target'),
      }
    }
    dispose() {
      hoisted.disposed.push('generator')
    }
  }
  return { ...actual, PMREMGenerator: FakePMREMGenerator }
})

const { createLensEnvironment } = await import('../../src/core/lensEnvironment.js')

describe('createLensEnvironment', () => {
  beforeEach(() => {
    hoisted.disposed = []
    hoisted.source = null
  })

  it('returns the prefiltered texture', () => {
    const env = createLensEnvironment({})
    expect(env.texture.name).toBe('prefiltered-env')
  })

  it('tags the source texture linear and equirectangular', () => {
    // Required, not decorative: DataTexture defaults to NoColorSpace, and PMREM
    // expects linear. Untagged, rendered sun brightness silently decouples from
    // sunIntensity and looks exactly like an intensity-tuning problem.
    createLensEnvironment({})
    expect(hoisted.source.colorSpace).toBe(THREE.LinearSRGBColorSpace)
    expect(hoisted.source.mapping).toBe(THREE.EquirectangularReflectionMapping)
    expect(hoisted.source.type).toBe(THREE.FloatType)
  })

  it('disposes all three GPU resources, not just the env texture', () => {
    // RenderLoop builds the env map at construction, so an incomplete dispose
    // leaks once per model swap.
    const textureDispose = vi.spyOn(THREE.Texture.prototype, 'dispose')
    const env = createLensEnvironment({})
    env.dispose()
    expect(textureDispose).toHaveBeenCalled()
    expect(hoisted.disposed).toContain('target')
    expect(hoisted.disposed).toContain('generator')
    textureDispose.mockRestore()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tryon/lensEnvironment.test.js`
Expected: FAIL — `Failed to resolve import "../../src/core/lensEnvironment.js"`

- [ ] **Step 3: Write minimal implementation**

Create `src/core/lensEnvironment.js`:

```js
/**
 * Builds the lens reflection environment: a procedural sky, PMREM-prefiltered
 * so it can be used as an envMap.
 *
 * Applied to LENS materials only (see lensReflection.js). scene.environment is
 * deliberately never assigned — that would light the frame too and bring back
 * the glare removed in 2e12c0f.
 */
import * as THREE from 'three'
import { createSkyPixels } from './skyTexture.js'

const WIDTH = 128
const HEIGHT = 64

export function createLensEnvironment(renderer, options = {}) {
  const pixels = createSkyPixels({ width: WIDTH, height: HEIGHT, ...options })

  const source = new THREE.DataTexture(pixels, WIDTH, HEIGHT, THREE.RGBAFormat, THREE.FloatType)
  source.mapping = THREE.EquirectangularReflectionMapping
  // REQUIRED: DataTexture defaults to NoColorSpace and PMREM expects linear
  // radiance, which is what createSkyPixels emits.
  source.colorSpace = THREE.LinearSRGBColorSpace
  source.needsUpdate = true

  const generator = new THREE.PMREMGenerator(renderer)
  generator.compileEquirectangularShader()
  const target = generator.fromEquirectangular(source)

  return {
    texture: target.texture,
    dispose() {
      source.dispose()
      target.dispose()
      generator.dispose()
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tryon/lensEnvironment.test.js`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/lensEnvironment.js test/tryon/lensEnvironment.test.js
git commit -m "feat(engine): PMREM lens environment wrapper"
```

---

### Task 4: Wire the environment into the render path

**Files:**
- Modify: `src/core/RenderLoop.js` (imports; `init()` after the renderer exists; new `dispose()`)
- Modify: `src/models/GlassesModelLoader.js` (constructor; both lens branches)
- Modify: `src/tryon/providers/MediaPipeThreeProvider.js:80` and `:151-159`
- Test: `npx vitest run test/tryon` (whole suite) + device pass

**Interfaces:**
- Consumes: `createLensEnvironment` (Task 3), `resolveLensReflectionConfig` and `applyLensReflection` (Task 2).
- Produces: `renderLoop.lensEnvMap` (`THREE.Texture | null`), `renderLoop.lensReflection` (config object), `renderLoop.dispose()`.

Ordering note: `RenderLoop.init()` runs at `MediaPipeThreeProvider.js:73`, **before** `new GlassesModelLoader()` at `:80`, so the env map already exists when the loader is constructed. Do not reorder these.

- [ ] **Step 1: Add the env map to RenderLoop.init()**

In `src/core/RenderLoop.js`, add to the imports at the top of the file:

```js
import { createLensEnvironment } from './lensEnvironment.js'
import { resolveLensReflectionConfig } from './lensReflection.js'
```

Then in `init()`, immediately after `this.renderer.setPixelRatio(...)` and before `this.scene = new THREE.Scene()`, insert:

```js
    // Lens reflections. Ambient light casts no specular, so a glossy lens has
    // nothing to bounce; this env map is the thing being reflected. Assigned
    // per-material to lenses only (never scene.environment) so the frame keeps
    // the flat look 2e12c0f deliberately gave it.
    this.lensReflection = resolveLensReflectionConfig(window.location.search)
    this.lensEnvironment = createLensEnvironment(this.renderer, {
      sunAzimuthDeg: this.lensReflection.sunAzimuthDeg,
      sunElevationDeg: this.lensReflection.sunElevationDeg,
    })
    this.lensEnvMap = this.lensEnvironment.texture
```

- [ ] **Step 2: Add RenderLoop.dispose()**

In `src/core/RenderLoop.js`, immediately after the existing `stop()` method (around line 695), add:

```js
  dispose() {
    this.stop()
    this.lensEnvironment?.dispose?.()
    this.lensEnvironment = null
    this.lensEnvMap = null
  }
```

- [ ] **Step 3: Teach the loader to apply reflections**

In `src/models/GlassesModelLoader.js`, add to the imports:

```js
import { applyLensReflection } from '../core/lensReflection.js'
```

Replace the constructor (lines 36-41) with:

```js
  constructor(options = {}) {
    this.dracoDecoderPath = options.dracoDecoderPath ?? 'draco/gltf/'
    this.lensEnvMap = options.lensEnvMap ?? null
    this.lensReflection = options.lensReflection ?? null
    this.loader = null
    this.dracoLoader = null
    this.cache = new Map()
  }
```

In the `preserveMaterials` branch, replace:

```js
          if (name.includes('lens') || name.includes('glass')) {
            if ('transmission' in material) material.transmission = 0
            material.transparent = true
            material.opacity = Number.isFinite(materialProfile.lensOpacity) ? materialProfile.lensOpacity : 0.5
            material.depthWrite = false
          }
```

with:

```js
          if (name.includes('lens') || name.includes('glass')) {
            if ('transmission' in material) material.transmission = 0
            material.transparent = true
            material.opacity = Number.isFinite(materialProfile.lensOpacity) ? materialProfile.lensOpacity : 0.5
            material.depthWrite = false
            applyLensReflection(material, this.lensEnvMap, this.lensReflection)
          }
```

In the non-preserve lens branch, replace:

```js
          if ('opacity' in material) {
            material.opacity = materialProfile.lensOpacity ?? 0.62
          }
        }
```

with:

```js
          if ('opacity' in material) {
            material.opacity = materialProfile.lensOpacity ?? 0.62
          }

          applyLensReflection(material, this.lensEnvMap, this.lensReflection)
        }
```

- [ ] **Step 4: Wire the provider**

In `src/tryon/providers/MediaPipeThreeProvider.js`, replace line 80:

```js
    this.glassesLoader = await new GlassesModelLoader().init()
```

with:

```js
    this.glassesLoader = await new GlassesModelLoader({
      lensEnvMap: this.renderLoop.lensEnvMap,
      lensReflection: this.renderLoop.lensReflection,
    }).init()
```

Then in `destroy()`, replace:

```js
    this.faceTracker?.dispose?.()
```

with:

```js
    this.faceTracker?.dispose?.()
    this.renderLoop?.dispose?.()
```

- [ ] **Step 5: Run the whole suite and build**

Run: `npx vitest run test/tryon`
Expected: PASS — 23 tests across 6 files (7 pre-existing + 5 sky + 8 reflection + 3 environment)

Run: `npm run build:engine`
Expected: `✓ built in <n>s`, no errors

- [ ] **Step 6: Commit**

```bash
git add src/core/RenderLoop.js src/models/GlassesModelLoader.js src/tryon/providers/MediaPipeThreeProvider.js
git commit -m "feat(engine): sun and sky reflections on lenses"
```

- [ ] **Step 7: Device verification (human-run — cannot be automated)**

The glint sweep is only truly verifiable on a real phone.

1. `npm run build:engine`, then `shopify app dev`.
2. Paste the **new** tunnel URL into the theme block's Engine URL — it changes every restart.
3. Open the PDP on a phone signed into the Shopify admin, tap Try on.
4. Confirm: the hotspot travels across the lens as the head turns; it does not strobe, crawl, or alias; **the frame looks unchanged from before**.
5. Tune with `?lensrefl=`, `?lensrough=`, `?sunaz=`, `?sunel=` appended to the block's Engine URL. `sunaz` decides at what head angle the flare hits.
6. Bake the winning values into `DEFAULTS` in `src/core/lensReflection.js` and commit.

**If the sun reads as a grey smudge rather than a bright flare:** this is the known risk in the spec. Alpha blending dims the reflection toward the backdrop instead of adding to it. Raise `?lensrefl` first. If no value works, stop and escalate — the fallback (additive glint compositing) is a materially larger change and is deliberately not pre-built.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Procedural sky gradient + sun disc | 1 |
| Linear radiance, sunIntensity may exceed 1 | 1 (Global Constraints + test) |
| `DataTexture` + PMREM, tagged `LinearSRGBColorSpace` | 3 (test asserts the tag) |
| `dispose()` frees all three resources | 3 (test) + 4 (`RenderLoop.dispose`, provider call) |
| Lens-only, never `scene.environment` | 2 (`applyLensReflection` is per-material) + 4 |
| Roughness clamp floor ~0.06 | 2 (test: authored 0 → 0.06; authored 0.3 untouched) |
| `envMapIntensity` default ~1.8 for the 0.62 alpha | 2 |
| Both loader lens branches | 4 |
| `?lensrefl` `?lensrough` `?sunaz` `?sunel` | 2 |
| Device pass + bake | 4 Step 7 |
| Known risk / escalation path | 4 Step 7 |

No gaps.

**Type consistency:** `createSkyPixels` accepts `sunSizeDeg` and `sunIntensity` and is called by `createLensEnvironment` with only `sunAzimuthDeg`/`sunElevationDeg` forwarded, relying on defaults for the rest — consistent. `resolveLensReflectionConfig` produces exactly the four keys `applyLensReflection` and `createLensEnvironment` consume. `renderLoop.lensEnvMap`/`lensReflection` names match between Task 4's RenderLoop and provider edits.

**Placeholders:** none.
