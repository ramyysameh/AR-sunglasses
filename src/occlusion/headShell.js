/**
 * Closed head shell for glasses occlusion.
 *
 * Replaces the earlier open "ear skirt" strip, which measurably did not work:
 * with ?pixdbg=1 it removed 6-24% of temple pixels but left the arm's rear
 * screen extent unchanged (0 px of trim at every angle), because an open strip
 * cannot hide a hook that reaches past its edge -- and scaling the strip up
 * 2.5x changed nothing. Occlusion needs a closed volume.
 *
 * So: take MediaPipe's full face-oval ring, push it outward where the head is
 * widest (the ears), extrude it backwards along the head's own -Z, and cap the
 * back. Together with the landmark face mask that already fills the front, that
 * is a sealed bucket the size and shape of the head. The temple arm stays
 * visible where it runs outside that surface and disappears where it passes
 * inside it, which is what an ear physically does.
 *
 * Landmark-driven rather than an authored canonical head on purpose: it scales
 * to each face for free, where a rigid mesh would need its own fitting pass and
 * would still be wrong for faces away from the average.
 *
 * Pure geometry, free of Three.js scene objects so it can be tested headlessly.
 */

/**
 * MediaPipe's FACE_OVAL, as a single connected loop starting at the forehead
 * and running down the subject's left side, across the chin, and back up.
 * Order matters: the wall triangles stitch consecutive entries.
 */
export const FACE_OVAL_RING = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
  400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21,
  54, 103, 67, 109,
]

export const RING_LENGTH = FACE_OVAL_RING.length

/** Landmark pair spanning the face, used to size the shell against the head. */
export const TEMPLE_SPAN_LANDMARKS = { left: 234, right: 454 }

/**
 * How far back the shell reaches, as a fraction of the temple span.
 *
 * Sized to contain the temple TIP, not to match anatomy: measured against a
 * 0.147 m frame the rearmost glasses vertex sat ~0.09 past the ring in the
 * mask's (depth-compressed) space, against a span of ~0.174 -- so ~0.52 is the
 * floor and this carries margin for longer temples. Over-extruding is cheap:
 * the shell only grows further behind the head, where there is nothing left to
 * wrongly hide. Tunable with ?shelldepth.
 */
export const DEFAULT_SHELL_DEPTH_RATIO = 0.8

/**
 * Outward bulge at the ear ring, as a fraction of the temple span.
 *
 * The face oval is the silhouette of the FACE, and the skull behind it is wider:
 * projected against the rendered head, the oval sits 20-24 px inside the real
 * silhouette at ear height. A shell built flat on the oval therefore hides the
 * temple tip later than the head would, and that showed up as the tip sailing
 * past the ear on every model.
 *
 * This was 0 for a long time, chosen against earGapPx and rearTrimPx -- metrics
 * that paid an occluder for REMOVING arm, so any bulge looked like damage. The
 * old measurement table is preserved below for exactly that reason. Re-derived
 * against the head-frame metric, a small bulge is what lets the tip hide with
 * LESS curl, which in turn leaves the arm further out where it runs past the
 * cheek. That coupling is the point: widening the shell and reducing the curl
 * both help, where every single knob on its own only traded one model against
 * another.
 *
 *   bulge        0      0.05
 *   GRIPZ      14/16   16/16
 *   WILLOW     16/16   16/16
 *   LARSSON    16/16   15/16
 *   (at splay 20, curl 22, cut 0.66; bulge 0 needs curl 28 and still leaves
 *    WILLOW 0.006 past the bound with GRIPZ 0.001 off the other one)
 *
 * Superseded measurements, kept because they are why this sat at 0: against the
 * old screen-space metric a bulge scored 0/4 where zero scored 4/4 --
 *
 *   bulge   +0.078      0.0      -0.08
 *   earGap  +54..+11   -37..-29  -37..-29
 *
 * -- and that metric was later shown to reward an arm held away from the head.
 * Tunable with ?shellwide.
 */
export const DEFAULT_SHELL_LATERAL_RATIO = 0.05

function resolve(search, key, fallback, max) {
  const raw = parseFloat(new URLSearchParams(search).get(key))
  // 0 is meaningful for both (flat on the oval / no depth), so only cap above.
  return Number.isFinite(raw) && raw >= 0 && raw <= max ? raw : fallback
}

export function resolveShellDepthRatio(search) {
  return resolve(search, 'shelldepth', DEFAULT_SHELL_DEPTH_RATIO, 3)
}

export function resolveShellLateralRatio(search) {
  return resolve(search, 'shellwide', DEFAULT_SHELL_LATERAL_RATIO, 1)
}

/**
 * How much narrower the shell is at the BACK than at the face.
 *
 * The shell used to be a constant-section tube: the face oval swept ~150 mm
 * straight back at full width, plus the ear bulge. A head is not that shape --
 * it is widest around the ears and narrows to the occiput -- and the difference
 * is not cosmetic. At 28 degrees of yaw that tube's silhouette reached past the
 * head entirely, over the background, and swallowed the temple arm from about
 * the cheekbone backwards: the arm stopped dead in mid-air with a visible gap
 * before the ear. Collapsing the shell made the whole arm reappear and hook
 * correctly behind the ear, which is what identified it.
 *
 * Applied to the extruded ring's lateral and vertical offsets, so the shell
 * becomes a tapered cone rather than a cylinder. The tip still hides: it hooks
 * inward to ~55 mm while the tapered wall is still out at ~80 mm there.
 */
export const DEFAULT_SHELL_TAPER = 0.55

/**
 * Where the ear ring sits, as a fraction of the full extrusion depth.
 *
 * A head's widest point is around the ears, roughly a third of the way from the
 * face plane to the occiput, and it narrows from there back. One extruded ring
 * cannot express that: put the bulge on it and the whole tube is fat enough to
 * swallow the temple arm from the cheekbone backwards; taper it instead and the
 * wall is too narrow at the ear to hide the tip, which is what the shell exists
 * for. Measured both ways -- fat tube: arm cut in mid-air short of the ear;
 * tapered single ring: arm correct but occlusion 0/4 with zero rear trim.
 *
 * So the shell carries two rings: this one bulges outward to cover the ear, and
 * the back one tapers in behind it.
 */
export const DEFAULT_SHELL_EAR_DEPTH = 0.33

/** ?shellear=<0..1> */
export function resolveShellEarDepth(search) {
  return resolve(search, 'shellear', DEFAULT_SHELL_EAR_DEPTH, 1)
}

/** ?shelltaper=<0..1>; 1 restores the old constant-section tube. */
export function resolveShellTaper(search) {
  return resolve(search, 'shelltaper', DEFAULT_SHELL_TAPER, 1)
}

/**
 * Wall + back cap for the extruded ring.
 *
 * The occluder material is DoubleSide and only ever writes depth, so winding is
 * irrelevant here; what matters is that the surface is closed, since that is
 * the whole reason this replaced the open strip.
 *
 * @param {number} ringStart first ring vertex index
 * @param {number} extrudedStart first extruded vertex index (same order)
 * @param {number} capCenter index of the single vertex closing the back
 * @param {number} length ring vertex count
 * @returns {number[]} flat triangle index list
 */
export function shellTriangles(ringVertices, earStart, backStart, capCenter) {
  const indices = []
  const length = ringVertices.length

  for (let i = 0; i < length; i += 1) {
    const next = (i + 1) % length // wraps: the ring is a closed loop
    const r0 = ringVertices[i]
    const r1 = ringVertices[next]
    const a0 = earStart + i
    const a1 = earStart + next
    const b0 = backStart + i
    const b1 = backStart + next

    // Face oval -> ear plane, then ear plane -> back of the skull.
    indices.push(r0, r1, a1, r0, a1, a0)
    indices.push(a0, a1, b1, a0, b1, b0)
    // Back cap, as a fan around a single centre vertex
    indices.push(b0, b1, capCenter)
  }

  return indices
}

/**
 * MediaPipe's face tessellation, as triangles.
 *
 * Shipped as a connection (edge) list, but consecutive triples are the three
 * edges of one triangle -- a->b, b->c, c->a -- so the starts of each triple are
 * its corners. Verified against the data rather than assumed.
 *
 * This is what the occluder's front surface is built from. The previous
 * hand-written 22-vertex mask was far too coarse to act as a depth surface: it
 * could not put the nose and cheeks in front of a temple arm passing behind
 * them, so the far temple stayed visible through every turn.
 *
 * @param {Array<{start:number,end:number}>} tessellation FACE_LANDMARKS_TESSELATION
 * @returns {number[]} flat triangle index list
 */
export function tessellationTriangles(tessellation) {
  const indices = []

  for (let i = 0; i + 2 < tessellation.length; i += 3) {
    const a = tessellation[i]
    const b = tessellation[i + 1]
    const c = tessellation[i + 2]
    // Only accept genuinely closed triples, so a malformed or reordered table
    // degrades to fewer triangles instead of silently producing garbage ones.
    if (a.end === b.start && b.end === c.start && c.end === a.start) {
      indices.push(a.start, b.start, c.start)
    }
  }

  return indices
}

/** Distance between two points, tolerating either being missing. */
export function templeSpan(left, right) {
  if (!left || !right) {
    return 0
  }

  const dx = left.x - right.x
  const dy = left.y - right.y
  const dz = left.z - right.z

  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}
