/**
 * 1€ filter wrapper for THREE.Quaternion values using spherical interpolation.
 */
import * as THREE from 'three'
import { OneEuroFilter } from './OneEuroFilter.js'

export class QuaternionFilter {
  constructor(options = {}) {
    this.minCutoff = options.minCutoff ?? 0.5
    this.beta = options.beta ?? 0.05
    this.dCutoff = options.dCutoff ?? 1.0
    this.freq = options.freq ?? 60
    this.filtered = null
    this.lastTimestamp = null
    this.angularVelocityFilter = new OneEuroFilter({
      freq: this.freq,
      minCutoff: this.minCutoff,
      beta: this.beta,
      dCutoff: this.dCutoff,
    })
  }

  setParams(options = {}) {
    if (typeof options.freq === 'number') {
      this.freq = options.freq
    }

    if (typeof options.minCutoff === 'number') {
      this.minCutoff = options.minCutoff
    }

    if (typeof options.beta === 'number') {
      this.beta = options.beta
    }

    if (typeof options.dCutoff === 'number') {
      this.dCutoff = options.dCutoff
    }

    this.angularVelocityFilter.setParams({
      freq: this.freq,
      minCutoff: this.minCutoff,
      beta: this.beta,
      dCutoff: this.dCutoff,
    })
  }

  reset() {
    this.filtered = null
    this.lastTimestamp = null
    this.angularVelocityFilter.reset()
  }

  _alpha(cutoff, dt) {
    const safeCutoff = Math.max(cutoff, 1e-6)
    const safeDt = Math.max(dt, 1e-6)
    const tau = 1 / (2 * Math.PI * safeCutoff)
    return 1 / (1 + tau / safeDt)
  }

  filter(quaternion, timestamp = performance.now()) {
    const target = quaternion instanceof THREE.Quaternion
      ? quaternion.clone().normalize()
      : new THREE.Quaternion(quaternion.x, quaternion.y, quaternion.z, quaternion.w).normalize()

    if (!this.filtered) {
      this.filtered = target.clone()
      this.lastTimestamp = timestamp
      this.angularVelocityFilter.reset()
      return this.filtered.clone()
    }

    const previousTimestamp = this.lastTimestamp ?? timestamp
    const dt = Math.max((timestamp - previousTimestamp) / 1000, 1e-6)

    if (this.filtered.dot(target) < 0) {
      target.x *= -1
      target.y *= -1
      target.z *= -1
      target.w *= -1
    }

    const delta = this.filtered.clone().conjugate().multiply(target)
    const angle = 2 * Math.acos(THREE.MathUtils.clamp(delta.w, -1, 1))
    const angularVelocity = angle / dt
    const smoothedAngularVelocity = this.angularVelocityFilter.filter(angularVelocity, timestamp)
    const cutoff = this.minCutoff + this.beta * Math.abs(smoothedAngularVelocity)
    const alpha = this._alpha(cutoff, dt)

    this.filtered.slerp(target, alpha).normalize()
    this.lastTimestamp = timestamp

    return this.filtered.clone()
  }
}
