import * as THREE from 'three'

export const canonicalOffset = new THREE.Vector3(0, 0, 0)
export let scaleMultiplier = 1.0

// User-facing fine-tune offsets applied after matrix-based face pose placement.
export let yOffset = 0.0
export let xOffset = 0.0
export let zOffset = 0.0

export function setScaleMultiplier(value) {
	scaleMultiplier = Number.isFinite(value) ? value : 1.0
}

export function setYOffset(v) {
	yOffset = Number.isFinite(v) ? v : 0.0
}

export function setXOffset(v) {
	xOffset = Number.isFinite(v) ? v : 0.0
}

export function setZOffset(v) {
	zOffset = Number.isFinite(v) ? v : 0.0
}

// Rotation fine-tune offsets (degrees), applied on top of the tracked head pose.
export let rotOffsetX = 0.0 // pitch (tilt up/down)
export let rotOffsetY = 0.0 // yaw (turn left/right)
export let rotOffsetZ = 0.0 // roll (tilt sideways)

export function setRotOffsetX(v) { rotOffsetX = Number.isFinite(v) ? v : 0.0 }
export function setRotOffsetY(v) { rotOffsetY = Number.isFinite(v) ? v : 0.0 }
export function setRotOffsetZ(v) { rotOffsetZ = Number.isFinite(v) ? v : 0.0 }

// Global tracking smoothness: 0 = snappy (tracks fast, more jitter),
// 0.5 = default behavior, 1 = very smooth (more lag, less jitter).
export let trackingSmoothness = 0.5
export function setTrackingSmoothness(v) {
	trackingSmoothness = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5
}
