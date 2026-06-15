import assert from 'node:assert/strict'
import * as THREE from 'three'
import { LandmarkProcessor } from '../src/tracking/LandmarkProcessor.js'
import { VectorFilter } from '../src/filters/VectorFilter.js'
import { QuaternionFilter } from '../src/filters/QuaternionFilter.js'
import { FitCalibrator } from '../src/fit/FitCalibrator.js'
import { FaceSurfaceSolver } from '../src/fit/FaceSurfaceSolver.js'
import { LocalFaceScanner } from '../src/fit/LocalFaceScanner.js'
import { FaceFitSolver } from '../src/fit/FaceFitSolver.js'
import { getGlassesConfig } from '../src/config/arConfig.js'
import { loadGlbScene, measureScene } from './model-utils.mjs'

function makeLandmarks() {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }))
  landmarks[234] = { x: 0.25, y: 0.5, z: 0.01 }
  landmarks[454] = { x: 0.75, y: 0.5, z: -0.01 }
  landmarks[468] = { x: 0.43, y: 0.48, z: 0 }
  landmarks[473] = { x: 0.57, y: 0.48, z: 0 }
  landmarks[123] = { x: 0.28, y: 0.56, z: 0.02 }
  landmarks[352] = { x: 0.72, y: 0.56, z: -0.02 }
  landmarks[1] = { x: 0.5, y: 0.56, z: -0.04 }
  landmarks[6] = { x: 0.5, y: 0.48, z: -0.02 }
  landmarks[9] = { x: 0.5, y: 0.35, z: 0.01 }
  landmarks[10] = { x: 0.5, y: 0.28, z: 0.02 }
  landmarks[168] = { x: 0.5, y: 0.43, z: -0.01 }
  return landmarks
}

function makeResult(matrix = new THREE.Matrix4().makeTranslation(0, 0, -0.75)) {
  return {
    facialTransformationMatrixes: [{ data: matrix.toArray() }],
    faceLandmarks: [makeLandmarks()],
  }
}

const processor = new LandmarkProcessor()
const config = getGlassesConfig('sunglasses')
const pose = processor.processLandmarks(makeResult(), config, 0.5)

assert.ok(pose, 'valid MediaPipe result should return a pose')
assert.ok(pose.rawMatrix instanceof THREE.Matrix4, 'pose should expose the corrected raw matrix')
assert.ok(Number.isFinite(pose.position.x), 'position should be finite')
assert.ok(Number.isFinite(pose.quaternion.w), 'quaternion should be finite')
assert.ok(Number.isFinite(pose.fitScale) && pose.fitScale > 0, 'fit scale should be positive and finite')
assert.ok(Number.isFinite(pose.poseQuality) && pose.poseQuality > 0, 'pose quality should be finite')
assert.ok(pose.rawPose.position instanceof THREE.Vector3, 'pose should expose rawPose position')
assert.ok(pose.anchorPoints.irisCenter, 'pose should expose iris anchor')
assert.ok(pose.anchorPoints.noseTip, 'pose should expose nose tip anchor')
assert.ok(pose.faceMetrics.weightedFaceSpan > 0, 'pose should expose weighted face span')
assert.ok(pose.metrics.templeSpan > pose.metrics.irisSpan, 'temple span should exceed iris span in fixture')
assert.equal(processor.processLandmarks({}, config, 0.5), null, 'missing matrix should return null')
assert.equal(
  processor.processLandmarks({ facialTransformationMatrixes: [{ data: [] }], faceLandmarks: [makeLandmarks()] }, config, 0.5),
  null,
  'invalid matrix should return null'
)

const vectorFilter = new VectorFilter()
const firstVector = vectorFilter.filter(new THREE.Vector3(1, 2, 3), 0)
vectorFilter.filter(new THREE.Vector3(10, 20, 30), 16)
vectorFilter.reset()
const resetVector = vectorFilter.filter(new THREE.Vector3(4, 5, 6), 32)
assert.deepEqual(firstVector.toArray(), [1, 2, 3], 'vector filter should initialize with first sample')
assert.deepEqual(resetVector.toArray(), [4, 5, 6], 'vector filter reset should discard stale state')

const quaternionFilter = new QuaternionFilter()
const firstQuat = quaternionFilter.filter(new THREE.Quaternion().identity(), 0)
quaternionFilter.filter(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1), 16)
quaternionFilter.reset()
const resetQuat = quaternionFilter.filter(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5), 32)
assert.ok(Math.abs(firstQuat.length() - 1) < 1e-6, 'initial quaternion should be normalized')
assert.ok(Math.abs(resetQuat.length() - 1) < 1e-6, 'reset quaternion should be normalized')

const calibrator = new FitCalibrator({ targetSamples: 4 })
const firstCalState = calibrator.update(pose)
assert.equal(firstCalState.isReady, false, 'calibration should not finish on first stable sample')
for (let index = 0; index < 4; index += 1) {
  calibrator.update(processor.processLandmarks(makeResult(), config, 0.5))
}
const readyCalState = calibrator.getState()
assert.equal(readyCalState.isReady, true, 'calibration should finish after enough stable samples')
assert.ok(readyCalState.scaleBaseline.fitScale > 0, 'calibration should produce a scale baseline')

const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.01, 100)
camera.position.set(0, 0, 0)
camera.lookAt(0, 0, -1)
camera.updateProjectionMatrix()
const surfaceSolver = new FaceSurfaceSolver()
const surface = surfaceSolver.solve({
  pose,
  camera,
  calibrationState: readyCalState,
  modelConfig: config,
})
assert.ok(surface, 'face surface solver should return a surface solution')
assert.ok(Number.isFinite(surface.framePosition.x), 'surface solver frame position should be finite')
assert.ok(surface.surfaceQuality >= 0.75, 'surface quality should be high for complete landmarks')
assert.ok(
  surface.frameDepth >= surface.surfaceDepth + config.bridgeClearanceMeters,
  'frame depth should sit in front of the face surface by bridge clearance'
)
calibrator.updateSurface(surface)
assert.ok(calibrator.getState().surfaceBaseline.frameDepth < 0, 'calibrator should store surface baseline depth')

const movingPose = processor.processLandmarks(makeResult(), config, 0.5)
movingPose.anchorPoints.irisCenter.x += 0.2
const frozenCount = calibrator.getState().sampleCount
calibrator.update(movingPose)
assert.equal(calibrator.getState().sampleCount, frozenCount, 'unstable landmark jumps should be rejected')

const scanner = new LocalFaceScanner({
  stageTargets: { front: 2, yawLeft: 1, yawRight: 1, neutralReturn: 1 },
})
for (const yaw of [0, 0, -12, 12, 0]) {
  const scannedPose = processor.processLandmarks(makeResult(), config, 0.5)
  scannedPose.rawPose.euler.y = THREE.MathUtils.degToRad(yaw)
  scanner.update(scannedPose)
}
const scanState = scanner.getState()
assert.equal(scanState.isReady, true, 'local face scanner should produce a ready profile')
assert.ok(scanState.profile.faceWidth > 0, 'local face scan profile should include face width')

const faceFitSolver = new FaceFitSolver()
const fitSolution = faceFitSolver.solve({
  pose,
  landmarks: makeLandmarks(),
  faceMatrix: pose.rawMatrix,
  scanProfile: scanState,
  skuFitMetadata: config,
  camera,
})
assert.ok(fitSolution, 'face fit solver should return a solution')
assert.ok(Number.isFinite(fitSolution.glassesTransform.position.x), 'face fit position should be finite')
assert.ok(
  fitSolution.glassesTransform.scale >= config.scaleLimits.min &&
    fitSolution.glassesTransform.scale <= config.scaleLimits.max,
  'face fit scale should stay within configured limits'
)
assert.ok(Array.isArray(fitSolution.occlusionMesh.faceWorldPoints), 'face fit solver should expose face mesh points')

const responsiveFilter = new VectorFilter({ minCutoff: 2.4, beta: 0.12 })
responsiveFilter.filter(new THREE.Vector3(0, 0, 0), 0)
let response = new THREE.Vector3()
for (let frame = 1; frame <= 8; frame += 1) {
  response = responsiveFilter.filter(new THREE.Vector3(1, 0, 0), frame * 16.67)
}
assert.ok(response.x > 0.9, `fast filter should reach 90% response quickly, got ${response.x}`)

const normalizedScene = await loadGlbScene('public/models/normalized/sunglasses.glb')
const normalizedMeasurement = measureScene(normalizedScene)
assert.ok(
  normalizedMeasurement.size.x >= 0.14 && normalizedMeasurement.size.x <= 0.15,
  `normalized sunglasses width should be close to 0.145m, got ${normalizedMeasurement.size.x}`
)
assert.equal(config.scaleMultiplier, 1, 'normalized model scale multiplier should default to 1')
// scaleLimits confirmed on-device 2026-06-15: {min:0.85,max:1.15} produces a
// correctly-sized fit. (Initial commit used {1.05,1.85}; the re-tune to this
// tighter range is the intended value.)
assert.deepEqual(
  config.scaleLimits,
  { min: 0.85, max: 1.15 },
  'local face-fit scale limits should match the on-device-verified range'
)
assert.ok(config.faceFitWidthRatio > 0, 'SKU config should expose face-fit width ratio')
assert.ok(config.bridgePivot instanceof THREE.Vector3, 'SKU config should expose bridge pivot metadata')
assert.ok(config.leftHingePoint instanceof THREE.Vector3, 'SKU config should expose hinge metadata')

console.log('AR math validation passed')
