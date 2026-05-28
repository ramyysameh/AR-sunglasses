---
# AR Try-On Pipeline — Active Architecture

## Coordinate system contract
- MediaPipe Face Landmarker outputs landmarks in NORMALIZED image space (0–1).
  Raw landmark XYZ must NEVER be used directly as Three.js world coordinates.
- The ONLY valid source of 3D head pose is `facialTransformationMatrixes[0].data`
  — a Float32Array encoding a column-major 4×4 matrix in METRIC space.
- The Three.js PerspectiveCamera FOV MUST be derived from the actual video
  dimensions at runtime. Never hardcode 63 or any other number.

## Camera intrinsics formula (use in main.js)
  const fy = video.videoHeight * 1.2;
  const fovY = 2 * Math.atan(video.videoHeight / (2 * fy)) * (180 / Math.PI);
  camera = new THREE.PerspectiveCamera(fovY, video.videoWidth / video.videoHeight, 0.01, 100);
  // Re-run this whenever video dimensions change (resize or stream change).

## Canonical face space offsets
  Glasses are positioned with a LOCAL offset applied AFTER the matrix transform.
  The offset is in face-local (canonical) space, not world space.
  Default starting offset: new THREE.Vector3(0, -0.012, 0.018)
  This places the bridge at the nose bridge, not at the face centroid.

## Scale fitting — 3-metric blend
  Three measurements, weighted average:
  1. Temple span:    landmarks[234] ↔ landmarks[454]  weight 0.5
  2. Iris distance:  landmarks[468] ↔ landmarks[473]  weight 0.3
  3. Cheekbone:      landmarks[123] ↔ landmarks[352]  weight 0.2
  fitScale = (templeSpan * 0.5 + irisSpan * 0.3 + cheekSpan * 0.2)
             / model.userData.naturalWidth

## Motion prediction (add AFTER smoothing)
  prevPos and prevQuat are the filtered values from the previous frame.
  velocity = currentFilteredPos - prevPos   (THREE.Vector3 subtraction)
  predictedPos = currentFilteredPos + velocity * 1.5
  Apply predictedPos to glasses, not currentFilteredPos.
  Store currentFilteredPos as prevPos for next frame.

## Occlusion contract
  FaceOccluder MUST receive the SAME rawMatrix as the glasses model.
  Never compute a separate matrix for the occluder.
  occluder.material.colorWrite = false
  occluder.material.depthWrite = true
  occluder.renderOrder = -1
  glasses.renderOrder = 0

## Files and their single responsibility
  - FaceTracker.js       → run FaceLandmarker, return raw result only
  - LandmarkProcessor.js → convert result to { rawMatrix, position, quaternion }
  - DepthEstimator.js    → return fitScale from 3-metric blend
  - VectorFilter.js      → 1€ filter for THREE.Vector3
  - QuaternionFilter.js  → 1€ filter for THREE.Quaternion
  - RenderLoop.js        → orchestrate all of the above, apply prediction
  - GlassesModelLoader.js → load GLB, measure naturalWidth, store on userData
  - FaceOccluder.js      → apply rawMatrix, depth-only render
  - arConfig.js          → per-SKU canonical offset and scale only
  - DebugHUD.js          → live sliders + readouts, no logic
---
