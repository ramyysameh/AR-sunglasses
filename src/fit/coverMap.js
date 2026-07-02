/**
 * Maps a MediaPipe normalized landmark (0..1 in the *video* frame) to normalized
 * device coordinates for the *display* canvas, undoing the video's CSS
 * `object-fit: cover` crop. This keeps the glasses aligned with the face and
 * correctly proportioned no matter the browser window size/aspect.
 *
 * The camera must carry _videoW/_videoH (intrinsic video size) and
 * _clientW/_clientH (displayed canvas size), set in RenderLoop._syncSize().
 *
 * The X is mirrored to match the mirrored (selfie) video.
 */
export function coverNDC(anchor, camera) {
  const vw = camera?._videoW || camera?._clientW || 1
  const vh = camera?._videoH || camera?._clientH || 1
  const cw = camera?._clientW || vw
  const ch = camera?._clientH || vh

  // object-fit: cover -> scale the video up so it fully covers the container.
  const scale = Math.max(cw / vw, ch / vh)
  const dispW = vw * scale
  const dispH = vh * scale

  // Landmark position in displayed (cover) pixels, then shift for the crop.
  const px = anchor.x * dispW - (dispW - cw) / 2
  const py = anchor.y * dispH - (dispH - ch) / 2

  return {
    ndcX: -((px / cw) * 2 - 1), // mirror X (selfie view)
    ndcY: -((py / ch) * 2 - 1),
  }
}
