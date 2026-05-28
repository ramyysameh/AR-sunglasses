/**
 * 1€ filter wrapper for THREE.Vector3 values.
 */
import * as THREE from 'three'
import { OneEuroFilter } from './OneEuroFilter.js'

export class VectorFilter {
  constructor(options = {}) {
    this.x = new OneEuroFilter(options)
    this.y = new OneEuroFilter(options)
    this.z = new OneEuroFilter(options)
  }

  setParams(options = {}) {
    this.x.setParams(options)
    this.y.setParams(options)
    this.z.setParams(options)
  }

  reset() {
    this.x.reset()
    this.y.reset()
    this.z.reset()
  }

  filter(value, timestamp = performance.now()) {
    const vector = value instanceof THREE.Vector3 ? value : new THREE.Vector3(value.x, value.y, value.z)

    return new THREE.Vector3(
      this.x.filter(vector.x, timestamp),
      this.y.filter(vector.y, timestamp),
      this.z.filter(vector.z, timestamp),
    )
  }
}
