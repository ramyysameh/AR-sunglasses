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
