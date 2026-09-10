// Anchors expressed as proportions of frame width, for models whose geometry
// cannot be read confidently. A plausible placement derived from size alone
// beats a precise-looking placement derived from a misread mesh.
//
// Every ratio below is measured against the two hand-tagged reference models
// (both ~146mm frames) via scripts/anchor-audit.mjs, not guessed.

// Hinge X as a fraction of the band half-width: 0.9126 (Larsson), 0.8959 (GRIPZ).
export const HINGE_X_RATIO = 0.905

// The hinge sits just INSIDE the rear edge of the front band, not exactly on
// it: hand anchors are 1.1mm and 0.4mm forward of the measured cliff.
export const HINGE_Z_INSET_RATIO = 0.005

// Hinge Y below the top of the hinge column. Measured as column-top minus
// 8.4mm (Larsson) and 9.6mm (GRIPZ), and notably STABLE as the column widens
// -- unlike the column midpoint, which swings 6-14mm with the sampling span.
export const HINGE_Y_INSET_RATIO = 0.0616

// Bridge centre below the frame top: column midpoints -11.3mm and -11.8mm.
const BRIDGE_Y_RATIO = 0.078

// Bridge depth behind the front face: 3.6mm and 3.7mm. Only used when the
// bridge column cannot be measured -- when it can, its own z-midpoint hits the
// hand anchor exactly on both models.
const BRIDGE_Z_INSET_RATIO = 0.025

// A detected anchor further than this from the prior is not believed. 12% of
// frame width is ~17mm: wide enough not to fight ordinary frame-shape variation,
// tight enough to catch an anchor that has landed on the wrong feature entirely.
export const SANITY_WINDOW_RATIO = 0.12

function finite(p) {
  return p != null && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
}

export function canonicalAnchors(frameWidth, band) {
  const hingeX = (band.halfWidth || frameWidth / 2) * HINGE_X_RATIO
  const hingeY = -HINGE_Y_INSET_RATIO * frameWidth
  const hingeZ = band.frontZMin + HINGE_Z_INSET_RATIO * frameWidth
  return {
    bridge: {
      x: 0,
      y: -BRIDGE_Y_RATIO * frameWidth,
      z: band.frontZMax - BRIDGE_Z_INSET_RATIO * frameWidth,
    },
    leftHinge: { x: -hingeX, y: hingeY, z: hingeZ },
    rightHinge: { x: hingeX, y: hingeY, z: hingeZ },
  }
}

export function applyPrior(detected, prior, frameWidth) {
  if (!finite(detected)) {
    return { anchor: prior, source: 'prior' }
  }
  const limit = SANITY_WINDOW_RATIO * frameWidth
  const offset = Math.hypot(
    detected.x - prior.x,
    detected.y - prior.y,
    detected.z - prior.z,
  )
  return offset <= limit
    ? { anchor: detected, source: 'detected' }
    : { anchor: prior, source: 'prior' }
}
