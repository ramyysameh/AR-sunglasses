/**
 * Occlusion probe: measures what the engine ACTUALLY DREW, not what it should have.
 *
 * Built after a long session of chasing occlusion bugs with geometric proxies --
 * ray tests against the occluder, lateral distance to its surface, tip vertices
 * projected to screen. Those proxies disagreed with each other AND with the
 * render, and acting on them produced changes that shipped visible regressions.
 * The only question that matters is "were temple pixels drawn here?", and the
 * only honest way to answer it is to read the pixels back.
 *
 * Two design choices worth keeping:
 *
 *  - Renders to an offscreen target, NOT the visible canvas. Reading the canvas
 *    needs preserveDrawingBuffer, which renders the alpha canvas solid green on
 *    iOS, and getImageData on a full-size canvas is slow enough to starve the
 *    render loop -- while measuring, the mock head stopped turning and every
 *    sample came back at the same pose, silently invalidating A/B runs.
 *
 *  - Isolates the temple meshes. With the whole frame visible, a temple tip that
 *    projects onto the lens counts as "drawn" and the measurement is meaningless.
 *
 * The canvas is transparent wherever no glasses pixel landed, so alpha is an
 * exact glasses mask.
 */
import * as THREE from 'three'

/** Face-oval extremes, which sit at the tragion -- the ear reference. */
const EAR_LANDMARKS = [234, 454]

const TEMPLE_NAME = /temple/i
// Flat decals carry "temple" in their names but are not the arm, and they sit on
// its surface, so including them would report the arm as visible wherever a logo
// is -- regardless of whether the arm itself was occluded.
const NOT_TEMPLE = /logo|print|emblem|lettering|mark/i

function isTemple(mesh) {
  const label = `${mesh.name ?? ''} ${mesh.parent?.name ?? ''}`
  return TEMPLE_NAME.test(label) && !NOT_TEMPLE.test(label)
}

export class OcclusionProbe {
  constructor({ renderer, scene, camera, glassesRoot, faceOccluder }) {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    this.glassesRoot = glassesRoot
    this.faceOccluder = faceOccluder
    this.target = null
    this.buffer = null
  }

  _ensureTarget() {
    const size = this.renderer.getSize(new THREE.Vector2())
    const w = Math.max(1, Math.floor(size.x))
    const h = Math.max(1, Math.floor(size.y))
    if (this.target && this.target.width === w && this.target.height === h) {
      return { w, h }
    }
    this.target?.dispose()
    this.target = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    })
    this.buffer = new Uint8Array(w * h * 4)
    return { w, h }
  }

  /** Renders the current scene offscreen and returns the alpha-mask statistics. */
  _capture(w, h) {
    const prev = this.renderer.getRenderTarget()
    this.renderer.setRenderTarget(this.target)
    this.renderer.render(this.scene, this.camera)
    this.renderer.readRenderTargetPixels(this.target, 0, 0, w, h, this.buffer)
    this.renderer.setRenderTarget(prev)

    const d = this.buffer
    let count = 0
    let minX = w
    let maxX = -1
    for (let y = 0; y < h; y += 1) {
      const row = y * w
      for (let x = 0; x < w; x += 1) {
        if (d[(row + x) * 4 + 3] > 8) {
          count += 1
          if (x < minX) minX = x
          if (x > maxX) maxX = x
        }
      }
    }
    return { count, minX, maxX }
  }

  /**
   * Screen X of the ear, in the capture's pixel space.
   *
   * This is the reference the arm's visible end is judged against. Landmarks 234
   * and 454 are the face oval's widest points, which sit at the tragion -- the
   * notch in front of the ear canal, and very close to where a real temple
   * passes out of sight.
   */
  _earScreenX(w, headYaw) {
    const occ = this.faceOccluder?.occluderMesh
    const attribute = occ?.geometry?.attributes?.position
    if (!attribute || !this.camera) return null

    const v = (this._earTmp ??= new THREE.Vector3())
    const xs = []
    for (const index of EAR_LANDMARKS) {
      v.fromBufferAttribute(attribute, index).applyMatrix4(occ.matrixWorld).project(this.camera)
      if (!Number.isFinite(v.x)) continue
      xs.push((v.x * 0.5 + 0.5) * w)
    }
    if (!xs.length) return null
    // The rear side is the one the arm runs towards, which flips with yaw.
    return headYaw >= 0 ? Math.min(...xs) : Math.max(...xs)
  }

  /**
   * One measurement at the CURRENT pose.
   *
   * Both captures happen back to back without advancing the render loop, so the
   * only difference between them is the occluder -- which is what makes the
   * comparison trustworthy. Earlier attempts compared captures taken seconds
   * apart at different head angles and drew confident, wrong conclusions.
   *
   * `rearTrimPx` is the headline number: how much SHORTER the arm is on screen
   * with the occluder than without. An occluder that shaves the middle of the
   * arm but never shortens it scores 0 here, which is exactly the failure that
   * went undetected for hours.
   */
  measure(headYaw = 0) {
    const { w, h } = this._ensureTarget()
    const meshes = []
    this.glassesRoot.traverse((o) => {
      if (o.isMesh) meshes.push(o)
    })
    const temples = meshes.filter(isTemple)
    if (!temples.length) {
      return { error: 'no temple meshes found', meshes: meshes.map((m) => m.name) }
    }

    // Refuse to measure a frame where the glasses are not being drawn at all.
    // Tracking drops hide glassesRoot, and a probe that happily returns zeros
    // then is worse than useless: "nothing drawn because tracking died" and
    // "nothing drawn because the occluder hid it" produce identical numbers, and
    // the second is a perfect score. Sweeps silently full of the first are how a
    // broken occluder looks fixed.
    if (!this.glassesRoot.visible) {
      return { skipped: 'glasses hidden (tracking lost or calibrating)' }
    }

    const saved = meshes.map((m) => m.visible)
    meshes.forEach((m) => {
      m.visible = isTemple(m)
    })

    const on = this._capture(w, h)
    this.faceOccluder.hide()
    const off = this._capture(w, h)
    this.faceOccluder.show()

    meshes.forEach((m, i) => {
      m.visible = saved[i]
    })

    // Unoccluded temples drawing nothing means the capture is broken (wrong
    // camera, zero-sized target, meshes culled), not that occlusion is perfect.
    if (off.count === 0) {
      return { skipped: 'temples drew no pixels even with the occluder off' }
    }

    // Which screen edge the arm runs towards depends on which way the head is
    // turned, so "rear" flips with yaw.
    const rearTrimPx = off.count === 0
      ? 0
      : headYaw >= 0
        ? on.minX - off.minX
        : off.maxX - on.maxX

    // WHERE the arm ends, against where the ear is. This is the number that
    // actually describes the thing being judged; rearTrimPx describes how much
    // was removed, which is maximised by an occluder so large it eats the arm.
    const earX = this._earScreenX(w, headYaw)
    const armEndX = headYaw >= 0 ? on.minX : on.maxX
    const earGapPx = earX == null || on.count === 0
      ? null
      : headYaw >= 0
        ? armEndX - earX
        : earX - armEndX

    return {
      yaw: Math.round(headYaw * 10) / 10,
      templePixelsOn: on.count,
      templePixelsOff: off.count,
      hiddenPct: off.count ? Math.round((100 * (off.count - on.count)) / off.count) : 0,
      rearTrimPx,
      // > 0: the arm stops SHORT of the ear (occluder eating it).
      // < 0: the arm carries on PAST the ear (tip not hidden).
      earGapPx: earGapPx == null ? null : Math.round(earGapPx),
      earScreenX: earX == null ? null : Math.round(earX),
      // Raw extents, so the verdict above can be audited rather than trusted.
      // A derived number that cannot be checked against its inputs is how a
      // broken metric survives: several of this probe's predecessors reported
      // confident figures that disagreed with the render, and there was no way
      // to tell from the output alone which one was lying.
      extents: { onMinX: on.minX, onMaxX: on.maxX, offMinX: off.minX, offMaxX: off.maxX },
    }
  }
}

/**
 * Pass/fail criterion for a sweep.
 *
 * Keyed on WHERE the arm ends relative to the ear, not on how much of it was
 * removed.
 *
 * rearTrimPx -- the previous criterion -- measures how much shorter the arm got.
 * That is maximised by an occluder so large it swallows the arm, which is a real
 * and visible bug: measured on one model, an over-wide shell scored 4/4 with
 * 92 px of trim while the arm visibly died in mid-air over the cheek, and every
 * configuration that fixed the render scored 0/4. The metric was voting for the
 * defect, and repeatedly overruled the picture.
 *
 * Head-on, the arm is foreshortened and its rear extent is set by the hinge
 * rather than the tip, so only turned poses are judged.
 */
export const MIN_REAR_TRIM_PX = 6
export const JUDGED_ABOVE_YAW = 25

/**
 * How far the arm's visible end may sit from the ear, in pixels.
 *
 * Asymmetric on purpose. Stopping SHORT of the ear is the visible defect -- the
 * arm dies in mid-air over the cheek -- so it is held tight. Running a little
 * PAST the ear is what a real temple does before it hooks down behind the lobe,
 * so there is more room that way.
 */
export const EAR_GAP_MAX_SHORT_PX = 10
export const EAR_GAP_MAX_PAST_PX = 45

export function evaluate(rows) {
  // Skipped rows carry no measurement, so they cannot pass. Counting them
  // separately keeps a sweep that mostly failed to measure from looking like a
  // sweep that mostly passed.
  const skipped = rows.filter((r) => r.skipped)
  const measured = rows.filter((r) => !r.skipped && Number.isFinite(r.earGapPx))
  const judged = measured.filter((r) => Math.abs(r.yaw) >= JUDGED_ABOVE_YAW)
  const failures = judged.filter(
    (r) => r.earGapPx > EAR_GAP_MAX_SHORT_PX || r.earGapPx < -EAR_GAP_MAX_PAST_PX
  )
  return {
    judged: judged.length,
    passed: judged.length - failures.length,
    failed: failures.length,
    skipped: skipped.length,
    pass: judged.length > 0 && failures.length === 0,
    failingYaws: failures.map((r) => r.yaw),
    earGaps: judged.map((r) => r.earGapPx),
  }
}

/**
 * Renders what the USER would see, to a PNG data URL.
 *
 * The single most expensive gap in this project's feedback loop was that
 * automated runs could measure but not LOOK. Every geometry fix that passed its
 * numbers and was visibly broken -- arms hanging past the skull, a frame sitting
 * off the head -- got that far because the only eyes available were the user's.
 *
 * The AR canvas is transparent and the camera feed is a separate DOM element
 * behind it, so neither alone is what anyone sees. This composites the two off
 * the visible canvas entirely, so it works with the preview pane closed.
 *
 * ALIGNMENT IS APPROXIMATE -- good for reviewing many frames at once, not for
 * judging fit. The engine deliberately sets camera.aspect to something other
 * than the canvas aspect (0.49 against 0.66) and compensates inside coverNDC,
 * so re-deriving the object-fit: cover crop here does not reproduce the page's
 * layout exactly; measured against a real screenshot the frame lands about 4%
 * of frame width off horizontally. For fit and placement judgements, pin a mock
 * frame, drive it with __probe.tick(), and take a real screenshot -- that path
 * is exact, and tick() is what makes it work while the page is throttled.
 *
 * @param {OcclusionProbe} probe
 * @param {HTMLVideoElement} video
 * @returns {string} PNG data URL
 */
export function compositeFrame(probe, video) {
  const { w, h } = probe._ensureTarget()
  probe._capture(w, h) // fills probe.buffer with the current render

  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d')

  // Background: the camera frame, cropped the way the page crops it. Without
  // matching object-fit: cover the glasses would sit at the right pixels over a
  // differently-scaled face, which looks like a tracking bug that isn't there.
  if (video?.videoWidth) {
    const scale = Math.max(w / video.videoWidth, h / video.videoHeight)
    const dw = video.videoWidth * scale
    const dh = video.videoHeight * scale
    ctx.save()
    // The page mirrors the feed for a selfie view; match it or every capture
    // reads as left-right flipped against the live render.
    ctx.translate(w, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh)
    ctx.restore()
  } else {
    ctx.fillStyle = '#888'
    ctx.fillRect(0, 0, w, h)
  }

  // Foreground: the rendered glasses. readRenderTargetPixels returns rows
  // bottom-up, so they are flipped back on the way in.
  const overlay = ctx.createImageData(w, h)
  const src = probe.buffer
  for (let y = 0; y < h; y += 1) {
    const from = (h - 1 - y) * w * 4
    const to = y * w * 4
    overlay.data.set(src.subarray(from, from + w * 4), to)
  }
  const layer = document.createElement('canvas')
  layer.width = w
  layer.height = h
  layer.getContext('2d').putImageData(overlay, 0, 0)
  ctx.drawImage(layer, 0, 0)

  return out.toDataURL('image/png')
}
