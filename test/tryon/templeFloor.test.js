import { describe, it, expect } from 'vitest'
import { templeFloorMatrix, TEMPLE_FLOOR_DEPTH } from '../../src/occlusion/templeFloor.js'

/** Applies a column-major 4x4 to a point, the way three does. */
function apply(e, [x, y, z]) {
  return [
    e[0] * x + e[4] * y + e[8] * z + e[12],
    e[1] * x + e[5] * y + e[9] * z + e[13],
    e[2] * x + e[6] * y + e[10] * z + e[14],
  ]
}

/** A view direction that is not axis-aligned: a camera is never square to a head. */
const VIEW = (() => {
  const v = [0.3, -0.2, -0.93]
  const n = Math.hypot(...v)
  return v.map((c) => c / n)
})()

describe('templeFloorMatrix', () => {
  it('moves the shell straight away from the camera by exactly the bound', () => {
    const p = [0.11, -0.04, 0.37]
    const out = apply(templeFloorMatrix(VIEW, 0.02), p)
    for (let i = 0; i < 3; i += 1) expect(out[i]).toBeCloseTo(p[i] + VIEW[i] * 0.02, 12)
  })

  it('moves every point by the same vector, so the shell keeps its shape', () => {
    // A SCALE was the first attempt and it cannot work: shrinking the shell
    // moves its near wall AWAY from the camera, behind the very arm it is
    // supposed to stop, so it occludes nothing. Only a push along the view
    // axis puts a surface between the camera and a buried temple.
    const m = templeFloorMatrix(VIEW, 0.02)
    const a = apply(m, [0.5, 0.5, 0.5]).map((c, i) => c - 0.5)
    const b = apply(m, [-0.3, 0.1, 0.9]).map((c, i) => c - [-0.3, 0.1, 0.9][i])
    for (let i = 0; i < 3; i += 1) expect(a[i]).toBeCloseTo(b[i], 12)
  })

  it('pushes AWAY from the camera, never toward it', () => {
    // Toward the camera would hide MORE than the plain shell already does --
    // the arm would vanish everywhere instead of only where it is buried.
    const p = [0, 0, 0]
    const out = apply(templeFloorMatrix(VIEW, 0.02), p)
    expect(out[0] * VIEW[0] + out[1] * VIEW[1] + out[2] * VIEW[2]).toBeGreaterThan(0)
  })

  it('is the identity at zero bound, so "no floor" costs nothing', () => {
    const p = [0.4, 0.5, 0.6]
    const out = apply(templeFloorMatrix(VIEW, 0), p)
    for (let i = 0; i < 3; i += 1) expect(out[i]).toBeCloseTo(p[i], 12)
  })

  it('normalises the view direction, so a caller cannot silently overshoot', () => {
    const p = [0, 0, 0]
    const out = apply(templeFloorMatrix([0, 0, -4], 0.02), p)
    expect(out[2]).toBeCloseTo(-0.02, 12)
  })

  it('refuses a degenerate direction rather than emitting NaN', () => {
    // A zero camera direction for one frame would otherwise put NaN in the
    // matrix, and a NaN depth write takes the whole head off screen.
    const out = templeFloorMatrix([0, 0, 0], 0.02)
    expect(out.every(Number.isFinite)).toBe(true)
    expect(apply(out, [0.4, 0.5, 0.6])).toEqual([0.4, 0.5, 0.6])
  })

  it('reuses the caller\'s array, so a per-frame call does not allocate', () => {
    const buf = new Array(16)
    expect(templeFloorMatrix(VIEW, 0.02, buf)).toBe(buf)
  })

  it('carries a bound clear of the deepest temple actually measured', () => {
    // Swept on all three models: temple pixels are flat from 0.04 down to
    // 0.010 and start dropping below it, so 0.010 is where the deepest temple
    // actually sits. Tighter than that trims arm the engine draws on purpose;
    // much looser and the bound stops meaning anything.
    expect(TEMPLE_FLOOR_DEPTH).toBeGreaterThan(0.010)
    expect(TEMPLE_FLOOR_DEPTH).toBeLessThan(0.025)
  })
})

describe('FaceOccluder floor lifecycle', () => {
  /** The two meshes and the flags the lifecycle actually touches. */
  const occluder = () => ({
    occluderMesh: { visible: true },
    innerOccluderMesh: { visible: false, matrix: { fromArray() { return this } }, matrixWorldNeedsUpdate: false },
  })

  it('brings the floor back up with the shell, not a frame later', async () => {
    // A measurement pass hides the shell and shows it again. If the floor does
    // not come back with it, there is a frame with the shell up and no floor --
    // exactly the state the floor exists to rule out.
    const { FaceOccluder } = await import('../../src/occlusion/FaceOccluder.js')
    const o = Object.assign(Object.create(FaceOccluder.prototype), occluder())
    o.aimTempleFloor({ x: 0, y: 0, z: -1 })
    expect(o.innerOccluderMesh.visible).toBe(true)
    o.hide()
    expect(o.innerOccluderMesh.visible).toBe(false)
    o.show()
    expect(o.innerOccluderMesh.visible).toBe(true)
  })

  it('leaves the floor down after show() when it was never aimed', async () => {
    // Before the first aim its matrix is the identity, which would put a
    // depth-writing copy of the shell exactly on top of the real one.
    const { FaceOccluder } = await import('../../src/occlusion/FaceOccluder.js')
    const o = Object.assign(Object.create(FaceOccluder.prototype), occluder())
    o.show()
    expect(o.innerOccluderMesh.visible).toBe(false)
  })

  it('drops the floor when the head frame goes away', async () => {
    const { FaceOccluder } = await import('../../src/occlusion/FaceOccluder.js')
    const o = Object.assign(Object.create(FaceOccluder.prototype), occluder())
    o.aimTempleFloor({ x: 0, y: 0, z: -1 })
    o.aimTempleFloor(null)
    expect(o.innerOccluderMesh.visible).toBe(false)
    o.show()
    expect(o.innerOccluderMesh.visible).toBe(false)
  })
})
