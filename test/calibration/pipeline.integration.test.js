import { describe, it, expect } from 'vitest'
import { buildFixtures } from '../../scripts/build-fixtures.mjs'
import { validateModel } from '../../src/calibration/validator.js'
import { normalizeModel } from '../../src/calibration/normalizer.js'
import { calibrate } from '../../src/calibration/calibrator.js'
import { MODELING_SPEC } from '../../src/calibration/spec.js'

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
