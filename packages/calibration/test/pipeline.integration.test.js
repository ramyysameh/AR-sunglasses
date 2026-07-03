import { describe, it, expect } from 'vitest'
import { buildFixtures } from './helpers/build-fixtures.mjs'
import { validateModel } from '../src/validator.js'
import { normalizeModel } from '../src/normalizer.js'
import { calibrate } from '../src/calibrator.js'
import { MODELING_SPEC } from '../src/spec.js'

function run(doc) {
  const validation = validateModel(doc, MODELING_SPEC)
  const { doc: normalized } = normalizeModel(doc, MODELING_SPEC)
  const calibration = calibrate(normalized, MODELING_SPEC)
  return { validation, calibration }
}

describe('calibration pipeline (end to end)', () => {
  it('tagged fixture → passes, tagged source, no manual', () => {
    const { validation, calibration } = run(buildFixtures().tagged)
    expect(validation.status).toBe('pass')
    expect(calibration.source).toBe('tagged')
    expect(calibration.needsManual).toBe(false)

    // normalizeModel recenters by a geometry-derived delta (dx=0, dy=-0.024 for
    // this fixture) and shifts the non-mesh tag nodes by that same delta, so the
    // authored anchors {0,0.024,0.02}/{-0.069,0,-0.01}/{0.069,0,-0.01} should come
    // out shifted by (0, -0.024, 0).
    const { bridgeAnchor, leftHinge, rightHinge } = calibration.fitMetadata
    expect(bridgeAnchor.x).toBeCloseTo(0, 4)
    expect(bridgeAnchor.y).toBeCloseTo(0, 4)
    expect(bridgeAnchor.z).toBeCloseTo(0.02, 4)
    expect(leftHinge.x).toBeCloseTo(-0.069, 4)
    expect(leftHinge.y).toBeCloseTo(-0.024, 4)
    expect(leftHinge.z).toBeCloseTo(-0.01, 4)
    expect(rightHinge.x).toBeCloseTo(0.069, 4)
    expect(rightHinge.y).toBeCloseTo(-0.024, 4)
    expect(rightHinge.z).toBeCloseTo(-0.01, 4)
  })

  it('good untagged fixture → confident geometric calibration', () => {
    const { calibration } = run(buildFixtures().good)
    expect(calibration.source).toBe('geometric')
    expect(calibration.needsManual).toBe(false)
    expect(calibration.fitMetadata.frameWidthMeters).toBeCloseTo(0.138, 2)
  })

  it('asymmetric fixture → flagged for manual', () => {
    const { calibration } = run(buildFixtures().asymmetric)
    expect(calibration.needsManual).toBe(true)
  })

  it('too-wide fixture → validator warns', () => {
    const { validation } = run(buildFixtures().tooWide)
    expect(validation.status).toBe('warn')
    expect(validation.issues.some((i) => i.code === 'WIDTH_OUT_OF_RANGE')).toBe(true)
  })
})
