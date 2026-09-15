import * as THREE from 'three'

const DEFAULT_FRAME_INTERVAL_MS = 1000 / 30
const MIN_FRAME_INTERVAL_MS = 1000 / 90
const MAX_FRAME_INTERVAL_MS = 1000 / 15

/**
 * Spreads each camera-frame pose change across the display frames between
 * detections. The target pose is already prediction-compensated upstream, so
 * this removes 30 Hz stepping without adding a full camera frame of latency.
 */
export class PoseInterpolator {
  constructor() {
    this.reset()
  }

  reset() {
    this.fromPosition = null
    this.fromQuaternion = null
    this.toPosition = null
    this.toQuaternion = null
    this.startTime = 0
    this.endTime = 0
  }

  push(position, quaternion, timestamp, frameIntervalMs = DEFAULT_FRAME_INTERVAL_MS) {
    if (!this.toPosition) {
      this.fromPosition = position.clone()
      this.fromQuaternion = quaternion.clone()
      this.toPosition = position.clone()
      this.toQuaternion = quaternion.clone()
      this.startTime = timestamp
      this.endTime = timestamp
      return
    }

    const current = this.sample(timestamp)
    const interval = THREE.MathUtils.clamp(
      Number.isFinite(frameIntervalMs) ? frameIntervalMs : DEFAULT_FRAME_INTERVAL_MS,
      MIN_FRAME_INTERVAL_MS,
      MAX_FRAME_INTERVAL_MS,
    )

    this.fromPosition.copy(current.position)
    this.fromQuaternion.copy(current.quaternion)
    this.toPosition.copy(position)
    this.toQuaternion.copy(quaternion)
    // Start halfway through the camera interval. The fresh render takes the
    // first half-step and the next display render completes it at 60 Hz.
    this.startTime = timestamp - interval * 0.5
    this.endTime = timestamp + interval * 0.5
  }

  sample(timestamp) {
    if (!this.toPosition) return null
    const duration = this.endTime - this.startTime
    const alpha = duration > 0
      ? THREE.MathUtils.clamp((timestamp - this.startTime) / duration, 0, 1)
      : 1
    return {
      position: this.fromPosition.clone().lerp(this.toPosition, alpha),
      quaternion: this.fromQuaternion.clone().slerp(this.toQuaternion, alpha),
    }
  }
}
