export function toEngineModelConfig(fitMetadata, modelUrl) {
  return {
    modelUrl,
    frameWidthMeters: fitMetadata.frameWidthMeters,
    bridgePivot: fitMetadata.bridgeAnchor,
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
