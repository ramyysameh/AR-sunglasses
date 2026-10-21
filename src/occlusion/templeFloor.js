/**
 * A FLOOR under the lifted temple: the head shell again, pushed away from the
 * camera, so an arm can win against the head by only so much.
 *
 * WHY THERE HAS TO BE ONE. The near temple is drawn BEFORE the depth-only shell
 * (templeHinge's TEMPLE_ON_TOP_ORDER), which is what stops the shell eating an
 * arm that rests on the head -- the shell is a coarse bucket, fatter than skin,
 * and without the lift it ate the arm from mid-cheek back. The cost was that
 * NOTHING then bounded how deep a lifted arm could be: in front of the ear it
 * drew whatever its geometry did, skull or no skull. This is that bound.
 *
 * WHY A PUSH AND NOT A SHRINK. The first attempt scaled the shell inward across
 * the face, reasoning that the penetration is lateral. It occludes nothing, and
 * the wireframe showed why in one glance: shrinking moves the near wall AWAY
 * from the camera, behind the very arm it was meant to stop. To hide a buried
 * temple a surface has to lie BETWEEN the camera and it, which means moving
 * along the view axis. Pushed back by B, the shell hides exactly what sits more
 * than B behind the true head surface, and the arm survives in the band above.
 *
 * HOW DEEP IT ACTUALLY GOES. Measured, not guessed, and not by inspecting
 * geometry -- a first attempt cast rays from each drawn vertex to the shell wall
 * and reported the rear of a GRIPZ temple twenty-five millimetres inboard, which
 * sounded alarming and was useless: with the lift removed entirely the shell
 * still did not hide that arm, so it was never behind the head from the camera
 * at all. The depth buffer is the only thing whose opinion matters here.
 *
 * So the bound is swept instead, and temple pixels counted, on each model:
 *
 *   bound (world units)   0.04   0.02   0.015   0.010   0.008   0.005   0.0002
 *   LARSSON at +51 yaw    3734   3731    3735    3730    3724    3679     3625
 *
 * Flat down to 0.010 and dropping below it: the deepest any temple currently
 * draws behind the head surface is about 0.010 world units, ~8.6 mm -- and since
 * the shell itself stands ~7.5 mm proud of the skin, that is a temple lying ON
 * the head, not through it. GRIPZ and WILLOW show no drop at any bound at all,
 * at every pose in a +/-53 degree sweep.
 *
 * THAT SWEEP WAS TOO NARROW, and 0.015 tripped. The Create-with-AI models on the
 * probe and real-face reels run much deeper, and the depth grows with yaw: rays
 * near the side of the head cross the shell at a grazing angle, so an arm lying
 * a few millimetres inside that fat shell sits centimetres behind it along the
 * view. Pixels of near arm the floor removed, against no floor at all, summed
 * over the turned frames of each reel:
 *
 *   bound                    0.015   0.025   0.035   0.045+
 *   probe-wide   round        4113    1350       0        0
 *                aviator      2652     703      76        0
 *                tortoise     2566    1312     282     noise (<30, flat to 0.07)
 *   hf-portrait  round        3306       2       0        0
 *   pitchyaw     round        1377      53       0        0
 *   kling        all three       0       0       0        0
 *
 * At 0.015 that was not "a few pixels": the near arm stopped 1-2 cm short of
 * the ear at 40-60 degrees, and where the arm rose back out of the band, a
 * detached triangle of it floated in the hair. With no floor every one of those
 * frames draws the arm lying along the head and nothing through it.
 *
 * The deepest legitimate arm is therefore ~0.04, and the value below is 1.5x
 * that, the same margin as before. It still bounds what it was built for -- an
 * arm drawn through the skull to the far side would have to sit a whole head's
 * half-width (~0.09) behind the near wall -- and the ear-plane clip that
 * prevents the eaten-from-the-cheek failure is untouched and independent.
 *
 * It is a bound, not a proof of zero. The band has to be at least as wide as the
 * shell's own inaccuracy or the shell goes back to eating arms, which is the
 * failure the lift exists to prevent.
 *
 * Plain arithmetic on arrays, no Three.js, so it can be tested headlessly.
 */

/**
 * How far behind the head surface the floor sits, in world units (~1.16 x
 * metres), measured along the view axis. See the sweep above.
 */
export const TEMPLE_FLOOR_DEPTH = 0.06

/**
 * Column-major 4x4 that translates by `bound` along `viewDirection`.
 *
 * @param {number[]} viewDirection unit vector from the camera into the scene;
 *   normalised here so a caller that forgets cannot overshoot
 * @param {number} bound how far behind the head surface the floor sits
 * @param {number[]} [out] reusable 16-element array
 * @returns {number[]} column-major elements, ready for Matrix4.fromArray
 */
export function templeFloorMatrix(viewDirection, bound, out = new Array(16)) {
  const length = Math.hypot(viewDirection[0], viewDirection[1], viewDirection[2])
  // A zero direction for one frame would put NaN in the matrix, and a NaN depth
  // write takes the whole head off screen. Fall back to "no floor".
  const scale = length > 0 && bound > 0 ? bound / length : 0

  for (let i = 0; i < 12; i += 1) out[i] = i % 5 === 0 ? 1 : 0
  out[12] = viewDirection[0] * scale
  out[13] = viewDirection[1] * scale
  out[14] = viewDirection[2] * scale
  out[15] = 1

  return out
}
