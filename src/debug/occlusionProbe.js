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
import { EAR_LANDMARKS, EYE_LANDMARKS, NOSE_LANDMARK, headFrame } from '../occlusion/headFrame.js'

// Re-exported so the probe's own tests, and anything already importing it from
// here, keep working; the definition lives with the renderer's copy so the two
// cannot drift apart.
export { headFrame }

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
    // Per-column occupancy, so a HOLE in the arm can be told from a shortened
    // arm. Both reduce the pixel count; only one of them looks like the arm
    // dissolving into the face.
    const columns = new Uint32Array(w)
    for (let y = 0; y < h; y += 1) {
      const row = y * w
      for (let x = 0; x < w; x += 1) {
        if (d[(row + x) * 4 + 3] > 8) {
          count += 1
          columns[x] += 1
          if (x < minX) minX = x
          if (x > maxX) maxX = x
        }
      }
    }
    return { count, minX, maxX, columns }
  }

  /**
   * Widest run of columns where the arm SHOULD be drawn and is not, with drawn
   * columns on both sides of it.
   *
   * A hole in the middle of an arm and an arm cut short both remove pixels, so
   * neither the pixel count nor the position of the arm's end can tell them
   * apart -- and the end-position check passes a fragmented arm happily. This
   * compares the occluded render against the unoccluded one column by column: a
   * column is a hole when the arm occupies it with the occluder off, is absent
   * with the occluder on, and has surviving arm on BOTH sides. That last clause
   * is what keeps a legitimately shortened tail from counting.
   */
  static _largestHole(on, off) {
    const w = off.columns.length
    let first = -1
    let last = -1
    for (let x = 0; x < w; x += 1) {
      if (on.columns[x] > 0) {
        if (first < 0) first = x
        last = x
      }
    }
    if (first < 0 || last <= first) return 0

    let worst = 0
    let run = 0
    for (let x = first; x <= last; x += 1) {
      if (on.columns[x] === 0 && off.columns[x] > 0) {
        run += 1
        if (run > worst) worst = run
      } else if (on.columns[x] > 0) {
        run = 0
      }
    }
    return worst
  }

  /**
   * A predicate selecting the arm on the side the head is turned towards.
   *
   * Side comes from each mesh's own position in the frame's local space, so it
   * needs no naming convention and no knowledge of how the arms were grouped.
   */
  _nearArmFilter(temples, headYaw) {
    if (!temples.length || !this.glassesRoot) return () => true
    const v = (this._sideTmp ??= new THREE.Vector3())
    const side = new Map()
    for (const mesh of temples) {
      const sphere = mesh.geometry?.boundingSphere ??
        (mesh.geometry?.computeBoundingSphere(), mesh.geometry?.boundingSphere)
      if (!sphere) continue
      v.copy(sphere.center).applyMatrix4(mesh.matrixWorld)
      this.glassesRoot.worldToLocal(v)
      side.set(mesh, Math.sign(v.x))
    }
    // Turn the head one way and the arm that stays in view is the other one.
    const near = headYaw >= 0 ? -1 : 1
    return (mesh) => side.get(mesh) === near
  }

  /**
   * The head's own fore-aft frame, with the EAR PLANE as its origin.
   *
   * @returns {{origin: THREE.Vector3, forward: THREE.Vector3, span: number} | null}
   */
  _headFrame() {
    const occ = this.faceOccluder?.occluderMesh
    const attribute = occ?.geometry?.attributes?.position
    if (!attribute || attribute.count <= Math.max(...EAR_LANDMARKS)) return null

    const read = (index, into) =>
      into.fromBufferAttribute(attribute, index).applyMatrix4(occ.matrixWorld)

    return headFrame(
      read(EAR_LANDMARKS[0], (this._frameA ??= new THREE.Vector3())),
      read(EAR_LANDMARKS[1], (this._frameB ??= new THREE.Vector3())),
      read(EYE_LANDMARKS[0], (this._frameC ??= new THREE.Vector3())),
      read(EYE_LANDMARKS[1], (this._frameD ??= new THREE.Vector3())),
      read(NOSE_LANDMARK, (this._frameE ??= new THREE.Vector3())),
      { origin: (this._frameOrigin ??= new THREE.Vector3()), forward: (this._frameForward ??= new THREE.Vector3()) },
    )
  }

  /**
   * Half-range of the depth encoding, world units either side of the ear plane.
   * Anything outside is clamped, which only matters for points far behind the
   * skull -- already a failure by any threshold here.
   */
  static DEPTH_RANGE = 0.25

  /**
   * Material that paints each arm fragment with its distance in front of the
   * ear plane, packed across two channels.
   *
   * Reading the answer out of the RENDER rather than out of the geometry is the
   * whole point. The obvious version of this -- project each arm vertex and ask
   * whether the pixel it lands on is lit -- looks equivalent and is not: at a
   * turned pose the arm overlaps itself on screen, so an occluded tip projects
   * onto pixels lit by the visible middle and reports itself as drawn. That
   * version put the arm's end 113 mm BEHIND the ear and claimed the occluder had
   * removed nothing, on a frame where it had plainly removed the tip. Letting
   * the rasterizer decide visibility is the only way to be sure.
   */
  _depthMaterial() {
    if (this._depthMat) return this._depthMat
    this._depthMat = new THREE.ShaderMaterial({
      uniforms: {
        uOrigin: { value: new THREE.Vector3() },
        uForward: { value: new THREE.Vector3() },
        uScale: { value: 1 / (2 * OcclusionProbe.DEPTH_RANGE) },
      },
      vertexShader: `
        #include <clipping_planes_pars_vertex>
        uniform vec3 uOrigin;
        uniform vec3 uForward;
        uniform float uScale;
        varying float vDepth;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vDepth = dot(worldPosition.xyz - uOrigin, uForward) * uScale + 0.5;
          vec4 mvPosition = viewMatrix * worldPosition;
          gl_Position = projectionMatrix * mvPosition;
          #include <clipping_planes_vertex>
        }
      `,
      fragmentShader: `
        #include <clipping_planes_pars_fragment>
        varying float vDepth;
        void main() {
          #include <clipping_planes_fragment>
          float d = clamp(vDepth, 0.0, 1.0);
          float hi = floor(d * 255.0) / 255.0;
          float lo = fract(d * 255.0);
          gl_FragColor = vec4(hi, lo, 0.0, 1.0);
        }
      `,
      side: THREE.DoubleSide,
      // Custom shaders do NOT get clipping for free. `clipping: true` only
      // declares the uniforms; the chunks above have to be included by hand, and
      // without them the planes are accepted and silently ignored -- the probe
      // then reads the near temple running 0.3 spans past the ear on a render
      // that cuts it at the ear.
      clipping: true,
    })
    return this._depthMat
  }

  /**
   * How far in front of the ear plane the arm's REARMOST DRAWN point sits.
   *
   * The predecessor to this measured screen X against the projected tragion, and
   * it was biased in the one direction that mattered: at a turned pose an arm
   * held away from the head projects further back than one lying against it, so
   * the metric paid for stand-off. It scored the configuration that visibly
   * floated 20 px off the skull as "reaching the ear" and the one that hugged it
   * as "stopping short" -- the same way rearTrimPx once scored an occluder for
   * eating the arm. Measured along the head's own fore-aft axis instead, moving
   * the arm sideways cannot change the number at all.
   *
   * @returns {number | null} world units; positive is in FRONT of the ear plane
   */
  _rearmostDrawn(arms, w, h, frame) {
    const material = this._depthMaterial()
    material.uniforms.uOrigin.value.copy(frame.origin)
    material.uniforms.uForward.value.copy(frame.forward)

    // Carry the arm's own clipping planes onto the depth material. Without this
    // the probe measures an arm the renderer never drew: the near temple is cut
    // at the ear plane by applyNearArmClip, and a swapped-in material with no
    // planes reports it running on past the ear.
    const saved = arms.map((m) => m.material)
    const clip = saved.find((m) => m?.clippingPlanes?.length)?.clippingPlanes ?? null
    if ((material.clippingPlanes?.length ?? 0) !== (clip?.length ?? 0)) {
      material.needsUpdate = true
    }
    material.clippingPlanes = clip
    arms.forEach((m) => { m.material = material })

    const prev = this.renderer.getRenderTarget()
    this.renderer.setRenderTarget(this.target)
    this.renderer.render(this.scene, this.camera)
    this.renderer.readRenderTargetPixels(this.target, 0, 0, w, h, this.buffer)
    this.renderer.setRenderTarget(prev)

    arms.forEach((m, i) => { m.material = saved[i] })

    const d = this.buffer
    const scale = material.uniforms.uScale.value
    let depth = null
    for (let i = 0; i < w * h; i += 1) {
      if (d[i * 4 + 3] === 0) continue
      const encoded = d[i * 4] / 255 + d[i * 4 + 1] / 65025
      const value = (encoded - 0.5) / scale
      if (depth === null || value < depth) depth = value
    }
    return depth
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

    // ?occdbg=1 draws the occluder as wireframe, which fills nothing and so
    // occludes nothing. Measuring there reports a flawless result no matter how
    // broken the occluder is -- it cost a full round of analysis on a sweep that
    // said 4/4 with zero holes while the bug was plainly on screen.
    if (this.faceOccluder?.occluderMesh?.material?.wireframe) {
      return { skipped: 'occluder is in wireframe debug mode and cannot occlude' }
    }

    // Measure ONE arm: the near one, the side the head is turned towards.
    //
    // With both in frame the far arm's entirely correct disappearance behind the
    // head reads as damage to the near arm. Measured on one model that inflated
    // the reported hole from 27-49 px to 116 px, and -- because nothing about the
    // far arm being hidden is wrong -- no change to the shell, to the depth
    // relief, or to the arm's own position moved the number at all. Three
    // levers were ruled out against a number that could not respond.
    const filter = this.templeFilter ?? this._nearArmFilter(meshes.filter(isTemple), headYaw)
    const saved = meshes.map((m) => m.visible)
    meshes.forEach((m) => {
      m.visible = isTemple(m) && filter(m)
    })

    const on = this._capture(w, h)
    this.faceOccluder.hide()
    const off = this._capture(w, h)
    this.faceOccluder.show()

    // Where the arm ENDS, along the head's fore-aft axis, drawn and undrawn.
    // Two numbers because they fail for different reasons and want different
    // fixes: with the occluder off at 38 degrees the closed gripz arm already
    // stops 42 px short of the ear, so a third of that shortfall is the frame's
    // own reach and no amount of occluder work can recover it.
    const frame = this._headFrame()
    const arms = meshes.filter((m) => isTemple(m) && filter(m))
    const drawnEnd = frame ? this._rearmostDrawn(arms, w, h, frame) : null
    let geometryEnd = null
    if (frame) {
      this.faceOccluder.hide()
      geometryEnd = this._rearmostDrawn(arms, w, h, frame)
      this.faceOccluder.show()
    }

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

    const round = (value) => (value == null ? null : Math.round(value * 1000) / 1000)

    return {
      yaw: Math.round(headYaw * 10) / 10,
      templePixelsOn: on.count,
      templePixelsOff: off.count,
      armHolePx: OcclusionProbe._largestHole(on, off),
      hiddenPct: off.count ? Math.round((100 * (off.count - on.count)) / off.count) : 0,
      rearTrimPx,
      // THE number the verdict is keyed on, as a fraction of the tragion-to-
      // tragion span so it is comparable across head sizes and does not depend
      // on world units being metres (they are not -- about 1.16x here, which is
      // how an earlier round "proved" the head 30% oversized).
      //   > 0  the arm stops SHORT of the ear plane
      //   < 0  it carries on PAST it, which is the hook
      earGapRatio: frame && drawnEnd != null ? round(drawnEnd / frame.span) : null,
      // The same thing before normalising, plus how much of the shortfall is the
      // FRAME rather than the occluder. reachRatio is a property of the model on
      // this head: no occluder change can move it.
      earGapWorld: round(drawnEnd),
      reachRatio: frame && geometryEnd != null ? round(geometryEnd / frame.span) : null,
      occluderAteWorld: drawnEnd != null && geometryEnd != null ? round(drawnEnd - geometryEnd) : null,
      // Kept, and deliberately NOT gated on: this is the screen-space figure the
      // verdict used to key on, retained so a run can show the bias rather than
      // just assert it -- it disagrees with earGapRatio exactly when the arm is
      // held away from the head.
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
 * Two independent ways for an arm to look wrong, so both are gated: it can stop
 * in the wrong PLACE (earGapRatio), and it can come apart in the MIDDLE
 * (armHolePx). Checking only the end passes a fragmented arm, which is how "the
 * middle dissolves into the face" survived a metric rewrite that was itself
 * fixing a blind spot.
 *
 * earGapRatio replaced a screen-space version of the same idea for the same
 * reason rearTrimPx was replaced before it: it could be satisfied without
 * fixing anything. An arm held away from the head projects further back at a
 * turned pose, so the screen measure paid for stand-off -- it scored the
 * configuration that floated 20 px off the skull as reaching the ear, and the
 * one lying against it as stopping short. Both are still reported, and they
 * disagree exactly when the arm is standing off.
 *
 * Head-on, the arm is foreshortened and its rear extent is set by the hinge
 * rather than the tip, so only turned poses are judged.
 */
export const MIN_REAR_TRIM_PX = 6
export const JUDGED_ABOVE_YAW = 25

/**
 * How far in FRONT of the ear plane the arm's drawn end may sit, as a fraction
 * of the tragion-to-tragion span.
 *
 * Asymmetric on purpose. Stopping short of the ear is the visible defect -- the
 * arm dies in mid-air over the cheek -- so it is held tight. Running PAST the
 * ear is what a real temple does before it hooks down behind the lobe, so there
 * is more room that way.
 *
 * Set from anatomy rather than from a sweep, deliberately: the previous bounds
 * were fitted to whatever the then-current configuration produced, which is how
 * a biased metric gets its thresholds blessed. A tragion span is ~145 mm on an
 * adult, so 0.05 is ~7 mm of shortfall -- about the most that still reads as
 * "ends at the ear" -- and 0.25 is ~36 mm behind the tragion, past the back of
 * the ear and well before the occiput.
 */
export const EAR_GAP_MAX_SHORT_RATIO = 0.05
export const EAR_GAP_MAX_PAST_RATIO = 0.25

/**
 * Widest hole allowed in the middle of a drawn arm, in pixels.
 *
 * An arm is one object; it does not come apart. A gap with arm on both sides is
 * the occluder cutting a bite out of it, which reads as the arm dissolving into
 * the face. Small values are antialiasing and the gaps between an arm's own
 * parts, so this is not zero.
 */
export const MAX_ARM_HOLE_PX = 8

export function evaluate(rows) {
  // Skipped rows carry no measurement, so they cannot pass. Counting them
  // separately keeps a sweep that mostly failed to measure from looking like a
  // sweep that mostly passed.
  const skipped = rows.filter((r) => r.skipped)
  const measured = rows.filter((r) => !r.skipped && Number.isFinite(r.earGapRatio))
  const judged = measured.filter((r) => Math.abs(r.yaw) >= JUDGED_ABOVE_YAW)
  const failures = judged.filter(
    (r) => r.earGapRatio > EAR_GAP_MAX_SHORT_RATIO ||
      r.earGapRatio < -EAR_GAP_MAX_PAST_RATIO ||
      (Number.isFinite(r.armHolePx) && r.armHolePx > MAX_ARM_HOLE_PX)
  )
  return {
    judged: judged.length,
    passed: judged.length - failures.length,
    failed: failures.length,
    skipped: skipped.length,
    pass: judged.length > 0 && failures.length === 0,
    failingYaws: failures.map((r) => r.yaw),
    earGaps: judged.map((r) => r.earGapRatio),
    // The reach the FRAME has on this head, occluder aside. A sweep that fails
    // with reachRatio already past the short bound is not an occlusion bug.
    reaches: judged.map((r) => r.reachRatio ?? null),
    armHoles: judged.map((r) => r.armHolePx ?? null),
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
