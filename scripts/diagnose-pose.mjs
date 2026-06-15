/**
 * Temporary diagnostic: feed known head rotations through LandmarkProcessor and
 * print the recovered euler angles, to verify pitch/yaw/roll survive the
 * coordinate-fix reflection. Not part of the build.
 */
import * as THREE from 'three'
import { LandmarkProcessor } from '../src/tracking/LandmarkProcessor.js'
import { getGlassesConfig } from '../src/config/arConfig.js'

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

function resultFor(eulerDeg) {
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(eulerDeg.x ?? 0),
    THREE.MathUtils.degToRad(eulerDeg.y ?? 0),
    THREE.MathUtils.degToRad(eulerDeg.z ?? 0),
    'XYZ'
  )
  const quat = new THREE.Quaternion().setFromEuler(euler)
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(0, 0, -40), // MediaPipe-style translation magnitude
    quat,
    new THREE.Vector3(1, 1, 1)
  )
  return { facialTransformationMatrixes: [{ data: matrix.toArray() }], faceLandmarks: [makeLandmarks()] }
}

const processor = new LandmarkProcessor()
const config = getGlassesConfig('sunglasses')

const cases = [
  { label: 'pitch UP   +20°', input: { x: 20 } },
  { label: 'pitch DOWN -20°', input: { x: -20 } },
  { label: 'yaw  LEFT  +30°', input: { y: 30 } },
  { label: 'yaw  RIGHT -30°', input: { y: -30 } },
  { label: 'roll       +15°', input: { z: 15 } },
]

for (const c of cases) {
  const pose = processor.processLandmarks(resultFor(c.input), config, 0.136)
  const e = pose.rawPose.euler
  const deg = (r) => (THREE.MathUtils.radToDeg(r)).toFixed(1)
  console.log(`${c.label}  ->  recovered euler (deg): x(pitch)=${deg(e.x)}  y(yaw)=${deg(e.y)}  z(roll)=${deg(e.z)}`)
}
