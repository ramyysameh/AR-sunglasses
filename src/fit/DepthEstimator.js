/**
 * Computes fitScale from the facial transformation matrix.
 * The matrix scale component is in METRIC space (meters) and is
 * distance-invariant — it does not shrink as the face moves back.
 */
export function computeFitScale(rawMatrix, naturalWidth) {
  if (!rawMatrix || !naturalWidth || naturalWidth === 0) return 1.0

  const scaleX = Math.sqrt(
    rawMatrix.elements[0] ** 2 +
    rawMatrix.elements[1] ** 2 +
    rawMatrix.elements[2] ** 2
  )
  const scaleY = Math.sqrt(
    rawMatrix.elements[4] ** 2 +
    rawMatrix.elements[5] ** 2 +
    rawMatrix.elements[6] ** 2
  )

  // Use average of X and Y scale as face size metric
  const faceScale = (scaleX + scaleY) / 2

  // faceScale is roughly the half-width of the canonical face in meters
  // Multiply by 2.8 to map to full glasses width
  const estimatedGlassesWidth = faceScale * 2.8

  return estimatedGlassesWidth / naturalWidth
}
