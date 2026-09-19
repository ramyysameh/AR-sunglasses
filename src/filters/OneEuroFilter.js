/**
 * Scalar 1€ filter used as the shared smoothing primitive for vector and quaternion filters.
 */
class LowPassFilter {
  constructor() {
    this.initialized = false
    this.value = 0
  }

  filter(value, alpha) {
    if (!this.initialized) {
      this.initialized = true
      this.value = value
      return value
    }

    this.value = alpha * value + (1 - alpha) * this.value
    return this.value
  }

  reset() {
    this.initialized = false
    this.value = 0
  }
}

export class OneEuroFilter {
  constructor(options = {}) {
    this.freq = options.freq ?? 60
    this.minCutoff = options.minCutoff ?? 1.0
    this.beta = options.beta ?? 0.007
    this.dCutoff = options.dCutoff ?? 1.0
    this.x = new LowPassFilter()
    this.dx = new LowPassFilter()
    this.lastTimestamp = null
    this.lastRawValue = null
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
  }

  reset() {
    this.x.reset()
    this.dx.reset()
    this.lastTimestamp = null
    this.lastRawValue = null
  }

  _alpha(cutoff, dt) {
    const safeCutoff = Math.max(cutoff, 1e-6)
    const safeDt = Math.max(dt, 1e-6)
    const tau = 1 / (2 * Math.PI * safeCutoff)
    return 1 / (1 + tau / safeDt)
  }

  filter(value, timestamp = performance.now()) {
    let dt = 1 / this.freq

    if (this.lastTimestamp !== null) {
      dt = Math.max((timestamp - this.lastTimestamp) / 1000, 1e-6)
      this.freq = 1 / dt
    }

    this.lastTimestamp = timestamp

    // The derivative is the input signal's velocity. Using the filtered value
    // here mistakes ordinary filter lag for continued motion, progressively
    // opens the cutoff, and makes each step accelerate instead of easing.
    const derivative = this.lastRawValue == null ? 0 : (value - this.lastRawValue) * this.freq
    this.lastRawValue = value
    const derivativeEstimate = this.dx.filter(derivative, this._alpha(this.dCutoff, dt))
    const cutoff = this.minCutoff + this.beta * Math.abs(derivativeEstimate)

    return this.x.filter(value, this._alpha(cutoff, dt))
  }
}
