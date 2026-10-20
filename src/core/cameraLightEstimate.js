/**
 * Room-light estimate from the camera image, for matching the frame's exposure
 * and white balance to the room it is being worn in.
 *
 * The frame is lit by a fixed ambient light and a fixed studio env map, so in a
 * dim or warm room it stays bright and neutral while the face around it goes dark
 * and orange -- the "pasted on" look. Meta's try-on doesn't solve this either
 * (one authored HDRI per product family, see FINDINGS.md); this is a cheap
 * improvement on that, not a light probe.
 *
 * What it estimates, and deliberately nothing more:
 *   - an INTENSITY scale from mean linear luminance against middle grey,
 *     compressed and clamped, because the camera's auto-exposure has already
 *     normalised most of the difference away -- what survives is the residual
 *     (backlit faces, very dim rooms) and that is what should carry over;
 *   - a COLOUR cast from the frame's mean chromaticity, desaturated and blended
 *     toward white so skin tone and a red wall cannot tint the frame.
 *
 * No direction. A directional key light from the estimate is what produced the
 * white streak sliding across the frame (removed in 2e12c0f); this only ever
 * scales the ambient light and the env reflection.
 *
 * Pure: pixels in, numbers out. The canvas sampling lives in RenderLoop.
 */

/** Middle grey in linear light: what an "ordinarily lit" frame averages to. */
const REFERENCE_LUMINANCE = 0.18

const DEFAULTS = {
  // ratio^exponent: 0.4 keeps a frame 3x darker than reference at ~0.64x
  // brightness rather than 0.33x, i.e. "dimmer room", not "black glasses".
  exponent: 0.4,
  minIntensity: 0.6,
  // Lower ceiling than floor on purpose: the frame's 1.0 ambient was tuned
  // against AgX on device, and a white wall behind the wearer pushed the
  // estimate to +25% and washed the frame out. Brightening is the rarer need.
  maxIntensity: 1.15,
  // Largest per-channel deviation from grey the cast may keep (linear units of
  // a unit-luminance colour). A tungsten room still reads warm; skin cannot
  // turn the frame orange.
  maxCast: 0.12,
  // How much of the measured cast to keep at all.
  castBlend: 0.5,
  // The face fills the middle of a selfie and is the least informative part
  // about the room's colour, so it counts less. It is NOT zeroed: it is lit by
  // the same light the glasses are, which is what the intensity should follow.
  centerWeight: 0.35,
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

// Byte -> linear lookup; 256 pow() calls once instead of one per pixel channel.
const LINEAR = new Float32Array(256)
for (let i = 0; i < 256; i += 1) LINEAR[i] = srgbToLinear(i / 255)

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

/**
 * @param {Uint8ClampedArray | Uint8Array | number[]} pixels RGBA bytes, row-major
 * @param {number} width
 * @param {number} height
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {{ intensity: number, color: { r: number, g: number, b: number }, luminance: number } | null}
 *   null when there is nothing usable to measure (empty or fully black frame)
 */
export function estimateCameraLight(pixels, width, height, options = {}) {
  const o = { ...DEFAULTS, ...options }
  if (!pixels || !(width > 0) || !(height > 0) || pixels.length < width * height * 4) return null

  const cx = (width - 1) / 2
  const cy = (height - 1) / 2
  const maxR2 = cx * cx + cy * cy || 1
  let r = 0
  let g = 0
  let b = 0
  let wSum = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / maxR2
      const w = o.centerWeight + (1 - o.centerWeight) * d2
      r += LINEAR[pixels[i]] * w
      g += LINEAR[pixels[i + 1]] * w
      b += LINEAR[pixels[i + 2]] * w
      wSum += w
    }
  }
  r /= wSum
  g /= wSum
  b /= wSum

  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  if (!(luminance > 1e-4)) return null

  const intensity = clamp((luminance / REFERENCE_LUMINANCE) ** o.exponent, o.minIntensity, o.maxIntensity)

  // Chromaticity at unit luminance, then pulled toward white twice: capped, then
  // only partially applied.
  const cast = (c) => {
    const deviation = clamp(c / luminance - 1, -o.maxCast, o.maxCast)
    return 1 + deviation * o.castBlend
  }
  return { intensity, color: { r: cast(r), g: cast(g), b: cast(b) }, luminance }
}

/**
 * Exponential moving average for the estimate, time-based so the response does
 * not depend on how often it is sampled. ~1.2 s: room light changes slowly, and
 * a faster response turns camera auto-exposure hunting into frame flicker.
 */
export class LightEstimateSmoother {
  constructor(timeConstantMs = 1200) {
    this.tau = timeConstantMs
    this.value = null
    this.lastTime = null
  }

  /**
   * @param {{ intensity: number, color: { r: number, g: number, b: number } } | null} sample
   * @param {number} timeMs
   */
  push(sample, timeMs) {
    if (!sample) return this.value
    if (!this.value || this.lastTime == null) {
      this.value = { intensity: sample.intensity, color: { ...sample.color } }
    } else {
      const dt = Math.max(0, timeMs - this.lastTime)
      const a = 1 - Math.exp(-dt / this.tau)
      const v = this.value
      v.intensity += (sample.intensity - v.intensity) * a
      v.color.r += (sample.color.r - v.color.r) * a
      v.color.g += (sample.color.g - v.color.g) * a
      v.color.b += (sample.color.b - v.color.b) * a
    }
    this.lastTime = timeMs
    return this.value
  }

  reset() {
    this.value = null
    this.lastTime = null
  }
}

/** ?lightest=0 turns estimation off and restores the fixed studio look. */
export function resolveLightEstimateEnabled(search) {
  return new URLSearchParams(search).get('lightest') !== '0'
}
