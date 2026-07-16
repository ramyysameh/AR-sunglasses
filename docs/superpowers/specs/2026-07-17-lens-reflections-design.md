# Lens Reflections — Design

**Date:** 2026-07-17
**Status:** Approved (design); implementation not started
**Scope:** Try-on engine (`src/`). Shared engine — affects every model, not just block models.

## Problem

Lenses read as flat matte shapes. Turning the head produces no change in the lens
surface, which is the strongest cue that the glasses are a rendered overlay rather
than a real object on the face.

The cause is not the lens material. `Smoke_Lens` in `gripzpelmo.glb` is authored at
`roughness: 0` — a perfect mirror — and the engine leaves it that way on the
`preserveMaterials` path that block models take. (Non-preserve models get
`lensRoughness: 0.08` from `arConfig.js`; both are glossy enough to reflect.) The cause
is that **there is nothing in the scene to reflect**:

- `RenderLoop.js:114` runs ambient-only. The key, fill, and rim `DirectionalLight`s are
  all at intensity `0`, set that way in `2e12c0f` to kill a distracting white specular
  glare on the glossy frame.
- No `scene.environment` is ever assigned.

A `THREE.AmbientLight` contributes uniform irradiance with **no specular term**. With no
env map and no directional light, a mirror-smooth lens has nothing to bounce, so gloss
is invisible.

## Goal

Sun glint *and* soft sky reflection on the lenses, sweeping across the surface as the
user turns their head — without reintroducing the frame glare that `2e12c0f` removed.

## Non-goals

- **Frame lighting.** The frame keeps its current appearance exactly. Giving it form via
  a subtle env map is a plausible follow-up, but it is the exact change that caused the
  glare regression and is deliberately excluded here.
- **Real-environment reflection.** Using the camera feed as the reflection source is more
  realistic but riskier: a prior camera-in-WebGL attempt broke mobile glasses scale and
  was reverted. Out of scope.
- **Lighting estimation.** Matching the reflection to the shopper's actual ambient light
  is a separate, larger problem (see the known-gaps list in the project brief).

## Approach

A procedural sky environment map, generated at runtime, applied **to lens materials only**.

One mechanism delivers both halves of the ask: a vertical gradient supplies the soft sky
base, and a bright sun disc composited into that same gradient supplies the glint.

The sweep requires no animation code. The env map is fixed in world space while
`glassesRoot` rotates with the head, so the reflection vector changes per-frame and the
hotspot travels across the lens on its own.

### Alternatives rejected

- **Ship an HDRI** (`RGBELoader` + PMREM). Most photographically believable, but adds a
  200KB–1MB asset to a mobile camera page already loading MediaPipe and a 6MB GLB, and
  offers almost no programmatic control over sun position — aiming the glint becomes an
  art task rather than a number. Wrong trade for a feature whose whole point is tuning.
- **Three's `RoomEnvironment`.** Zero assets, one line, but it is an indoor studio box:
  soft boxes and grey walls, no sun. Delivers the sky half and none of the glint.

## Components

### `src/core/skyTexture.js`

```
createSkyPixels({ width, height, sunAzimuthDeg, sunElevationDeg, sunSize, sunIntensity })
  -> Float32Array (RGBA, equirectangular)
```

Pure pixel math. Computes a vertical gradient (sky → horizon → ground) and composites a
soft-edged sun disc at the given direction.

**Values are linear radiance, not sRGB-encoded.** `PMREMGenerator` expects linear input, so
the gradient and disc math operate in linear space and are never gamma-encoded. `sunIntensity`
is therefore a linear multiplier and may exceed `1.0` — that is intended, not a bug.

Deliberately **no canvas and no DOM**, so it runs and gets asserted in Node under vitest —
the same testability posture as `glassesScale.js`.

### `src/core/lensEnvironment.js`

```
createLensEnvironment(renderer, options) -> { texture, dispose }
```

Wraps `createSkyPixels` output in a `THREE.DataTexture` with equirectangular mapping, runs
it through `PMREMGenerator.fromEquirectangular()`, returns the prefiltered texture plus a
`dispose` for teardown.

**Color space:** the `DataTexture` is explicitly tagged `THREE.LinearSRGBColorSpace` to match
the linear radiance `createSkyPixels` emits. `DataTexture` defaults to `NoColorSpace`, so this
tag is required, not decorative — leaving it unset decouples the rendered sun brightness from
`sunIntensity`, and that failure mode is indistinguishable from "intensity needs tuning". It
would be chased with `?lensrefl` and never found.

**`dispose()` contract:** frees all three GPU resources — the source `DataTexture`, the
`WebGLRenderTarget` returned by `fromEquirectangular()` (whose `.texture` is the env map), and
the `PMREMGenerator` instance. Disposing only the returned texture leaks the other two. This is
concrete rather than hypothetical: `RenderLoop` builds the env map once at construction, so a
`RenderLoop` rebuilt on product/model swap leaks once per swap.

The only component requiring a live GPU context, so it stays thin — construction and
delegation, no math.

### `src/core/lensReflection.js`

```
resolveLensReflectionConfig(search)
  -> { intensity, roughness, sunAzimuthDeg, sunElevationDeg }
```

Mirrors `resolveGlassesScaleMultiplier`'s shape and validation exactly: reads URL params,
rejects non-finite and out-of-range values, falls back to baked defaults.

## Data flow

1. `RenderLoop` constructs the env map **once**, at construction — it owns the renderer.
2. It passes the texture to `GlassesModelLoader`, which already walks materials and already
   detects lenses by name.
3. At that existing lens branch — in **both** the `preserveMaterials` path and the normal
   path — the loader sets `envMap`, `envMapIntensity`, and clamps roughness.

`scene.environment` is never assigned. The frame is therefore untouched **structurally**,
not by convention — there is no code path by which the env map can reach a frame material.

PMREM runs once at startup. Per-frame cost is zero beyond what the material already pays.

## Material specifics

**Roughness clamp.** `Smoke_Lens` is authored at `roughness: 0`. At true zero the sun disc
reflects as a hard, aliased dot that will crawl and strobe under head motion. Clamp lens
roughness up to a floor of ~`0.06` so the disc blooms into something that reads as a glint.

**Intensity compensation.** `GlassesModelLoader.js:117` forces `opacity: 0.62` and
`depthWrite: false` on lenses, because the authored `KHR_materials_transmission` stalls the
real-time renderer. Alpha blending scales the entire fragment, so at `envMapIntensity: 1`
the reflection arrives pre-dimmed by 38%. Default `envMapIntensity` to ~`1.8`.

**Lens detection is name-based** (`name.includes('lens') || name.includes('glass')`).
Verified against the real asset: `gripzpelmo.glb` exposes material `Smoke_Lens` and node
`lenses`, both of which match. Models whose lens meshes are named otherwise silently get no
reflection — a pre-existing limitation of this detection, not introduced here.

## Tuning parameters

Following the established `?gscale` / `?voffset` pattern: ship a sensible default, tune on a
real device, bake the winning value.

| Param | Meaning |
|---|---|
| `?lensrefl=<n>` | Reflection intensity (`envMapIntensity`) |
| `?lensrough=<n>` | Glint tightness (lens roughness floor) |
| `?sunaz=<deg>` | Sun azimuth — decides at what head angle the flare hits |
| `?sunel=<deg>` | Sun elevation |

`sunaz` is the parameter most likely to need movement, since it controls the head angle at
which the glint appears.

## Testing

**Unit (vitest, Node):**
- `createSkyPixels` — sun lands at the expected pixel coordinates for a given azimuth and
  elevation; gradient is monotonic top-to-bottom; disc falls off smoothly rather than
  hard-clipping.
- `resolveLensReflectionConfig` — overrides parse; non-finite, negative, and garbage input
  fall back to defaults; mirrors `glassesScale.test.js` case-for-case.
- Roughness clamp — an authored `0` lens comes out at the floor; an authored `0.3` lens is
  left alone.
- `dispose()` completeness — with a stubbed renderer, assert all three resources are disposed
  (source texture, render target, generator), not just the env map texture.

**Device (the only test that can actually validate this):**
Real phone, in the Shopify storefront. Turn the head through the full range and confirm the
hotspot travels smoothly, does not strobe or alias, and that the frame's appearance is
unchanged from before.

## Known risk

At 62% alpha with a dark smoke tint, the sun may read as a **grey smudge rather than a
bright flare** — alpha blending dims the reflection toward the backdrop instead of adding
to it.

If `envMapIntensity` alone cannot overcome this, the fallback is compositing the glint
additively (a separate additive-blended lens overlay pass, or `NormalBlending` → custom
blend equation) rather than through the alpha. That is a materially bigger change and is
deliberately **not** pre-built: confirm the cheap path fails on a real device first.
