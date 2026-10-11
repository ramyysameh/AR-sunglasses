import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { LocalFaceScanner } from '../../src/fit/LocalFaceScanner.js'

function frontPose(yawDeg = 0) {
  const anchor = { x: 0, y: 0, z: 0 }
  return {
    poseQuality: 1,
    anchorPoints: { bridgeCenter: anchor, irisCenter: anchor },
    rawMatrix: new THREE.Matrix4().makeTranslation(0, 0, -0.5),
    rawPose: { euler: { y: THREE.MathUtils.degToRad(yawDeg) } },
    faceMetrics: { weightedFaceSpan: 0.14 },
  }
}

describe('LocalFaceScanner', () => {
  it('locks on from the front view alone -- no head-turn stages', () => {
    const scanner = new LocalFaceScanner()
    const stages = new Set()
    let state = scanner.getState()
    for (let i = 0; i < 40 && !state.isReady; i++) {
      stages.add(state.activeStage)
      state = scanner.update(frontPose())
    }

    expect(state.isReady).toBe(true)
    expect([...stages]).toEqual(['front'])
    expect(state.profile.faceWidth).toBeCloseTo(0.14)
  })

  it('reports finite progress that climbs toward 1 while scanning', () => {
    const scanner = new LocalFaceScanner()
    const first = scanner.update(frontPose())
    const second = scanner.update(frontPose())

    expect(Number.isFinite(first.quality)).toBe(true)
    expect(second.quality).toBeGreaterThan(first.quality)
    expect(second.quality).toBeLessThan(1)
  })
})
