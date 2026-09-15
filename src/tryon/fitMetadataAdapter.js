/**
 * Maps calibration output onto the engine's model-config shape.
 *
 * This is where the engine's rendering conventions meet the calibration
 * package's pure geometry, so the knowledge that GlassesModelLoader re-origins
 * every model to (bboxCenterX, bboxCenterY, bboxMaxZ) -- depthPivot
 * 'frontMaxZ' -- lives HERE rather than inside @artryon/calibration.
 */

/**
 * The bridge anchor, restated relative to the origin the loader will give the
 * model.
 *
 * The solver rotates the frame about this point, so it has to be in the same
 * frame as the geometry it is moving. It was not: calibration measures in the
 * normalizer's frame, whose origin is put ON the bridge -- which makes the
 * measured anchor ~zero by construction -- while the loader re-origins to the
 * bounding box. The solver was handed ~zero, so (I - R)*pivot vanished and the
 * frame rotated about mid-lens height instead of the nose bridge. Measured
 * across four real models: 5-6 mm of drift at 15 degrees of pitch, 10-13 mm at
 * 30, and nothing at yaw -- a pure-Y pivot is invariant under Y rotation, which
 * is why the yaw-only mock sweep never showed it.
 *
 * Both points are measured in the same frame, so any rigid translation the
 * normalizer applied cancels here.
 *
 * NOT validated against pitch: the harness mock sweeps yaw only. On yaw it is
 * neutral -- four alternated sweeps per configuration put positive-yaw rear
 * trim equal or better with this applied, with one marginal angle near the
 * pass threshold going the other way. Build a pitch sweep before tuning
 * verticalOffset or the vertical lift any further, since those were set while
 * this pivot was collapsing to zero.
 */
function bridgePivotFor(fitMetadata) {
  const center = fitMetadata.modelBoundsCenter
  const anchor = fitMetadata.bridgeAnchor
  // Rows written before modelBoundsCenter existed keep the old behaviour rather
  // than being silently re-framed against a centre we do not have.
  if (!center) return anchor
  return {
    x: anchor.x - center.x,
    y: anchor.y - center.y,
    z: anchor.z - fitMetadata.frontFramePlaneZ,
  }
}

export function toEngineModelConfig(fitMetadata, modelUrl) {
  return {
    modelUrl,
    frameWidthMeters: fitMetadata.frameWidthMeters,
    bridgePivot: bridgePivotFor(fitMetadata),
    leftHingePoint: fitMetadata.leftHinge,
    rightHingePoint: fitMetadata.rightHinge,
    frontFramePlaneZ: fitMetadata.frontFramePlaneZ,
    lensCenterOffset: fitMetadata.lensCenterOffset,
    scaleLimits: fitMetadata.scaleLimits,
    // Uniform factor for a model authored outside metre space. The stored GLB is
    // the merchant's original, so this is the only thing telling the engine to
    // resize it. Absent on rows written before raw passthrough, where the
    // rescale was baked into the stored file instead -- GlassesModelLoader
    // treats the resulting undefined as a no-op so those are not shrunk twice.
    modelScale: fitMetadata.modelScale ?? 1,
  }
}
