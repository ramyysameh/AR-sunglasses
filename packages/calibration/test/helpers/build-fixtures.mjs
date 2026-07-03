import { buildDoc } from './buildDoc.js'

const GOOD = [
  -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, 0.02,
  -0.069, 0, -0.13, 0.069, 0, -0.13, 0, -0.02, 0.02,
]

// GOOD with the RIGHT temple tip moved inward (x 0.069 -> 0.02) so it is NOT a
// mirror image. A genuine shape asymmetry that survives the normalizer's recenter
// — unlike a uniform x-translation, which recenter would simply remove.
const ASYMMETRIC = [
  -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, 0.02,
  -0.069, 0, -0.13, 0.02, 0, -0.13, 0, -0.02, 0.02,
]

export function buildFixtures() {
  return {
    good: buildDoc(GOOD),
    tagged: buildDoc(GOOD, {
      AR_bridge: { x: 0, y: 0.024, z: 0.02 },
      AR_hinge_L: { x: -0.069, y: 0, z: -0.01 },
      AR_hinge_R: { x: 0.069, y: 0, z: -0.01 },
    }),
    asymmetric: buildDoc(ASYMMETRIC),
    tooWide: buildDoc(GOOD.map((v, i) => (i % 3 === 0 ? v * 4 : v))),
  }
}
