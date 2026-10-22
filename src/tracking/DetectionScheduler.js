/**
 * Runs face detection on the camera's own frame clock.
 *
 * With requestVideoFrameCallback (rVFC) the browser calls us once per video
 * frame it presents, so MediaPipe runs exactly once per real camera frame and
 * the pose filters get timestamps spaced like the camera's frames. Rendering
 * stays on requestAnimationFrame: the render step takes the newest detection
 * and the PoseInterpolator fills the display frames in between.
 *
 * Without rVFC (or with ?rvfc=0) the render step detects inline, as before,
 * and FaceTracker skips repeated frames by video.currentTime.
 */

// A frame delivered this much later than the best latency seen so far means
// the media clock jumped (new camera, new source), so the clock re-anchors.
const REANCHOR_MS = 250
// Lets the anchor follow a slow drift between the media and page clocks.
const DRIFT_MS_PER_FRAME = 0.05
// MediaPipe's VIDEO mode needs strictly increasing timestamps.
const MIN_STEP_MS = 1

export function hasVideoFrameCallback(video) {
  return typeof video?.requestVideoFrameCallback === 'function'
}

/**
 * Turns rVFC metadata into a timestamp on the page clock (performance.now)
 * that keeps the camera's own frame spacing.
 *
 * metadata.mediaTime gives the spacing: it is the frame's presentation time on
 * the media timeline, so consecutive frames differ by the real camera interval.
 * The offset onto the page clock is the smallest (callback time - mediaTime)
 * seen, so a stamp is never later than the callback that delivered it and the
 * render step, which runs later in the same display frame, never sees time go
 * backwards. expectedDisplayTime is not used as the anchor: it is a vsync ahead
 * of that render clock and snaps to vsync, which would add up to a display
 * frame of noise to every camera interval. It is only the fallback when a
 * browser gives no usable mediaTime.
 */
export class VideoFrameClock {
  constructor() {
    this.reset()
  }

  reset() {
    this.offset = null
    this.lastMediaTime = null
    this.last = null
  }

  stamp(now, metadata = {}) {
    const mediaMs = Number(metadata.mediaTime) * 1000
    let t
    if (Number.isFinite(mediaMs)) {
      const offsetNow = now - mediaMs
      const jumped = this.offset == null ||
        (this.lastMediaTime != null && mediaMs <= this.lastMediaTime) ||
        offsetNow - this.offset > REANCHOR_MS
      this.offset = jumped ? offsetNow : Math.min(this.offset + DRIFT_MS_PER_FRAME, offsetNow)
      this.lastMediaTime = mediaMs
      t = mediaMs + this.offset
    } else {
      const display = Number(metadata.expectedDisplayTime)
      t = Number.isFinite(display) ? Math.min(display, now) : now
    }
    if (this.last != null && t < this.last + MIN_STEP_MS) t = this.last + MIN_STEP_MS
    this.last = t
    return t
  }
}

export class DetectionScheduler {
  /**
   * @param {{ video: HTMLVideoElement, tracker: { detect: Function, detectFrame: Function },
   *   useVideoFrames?: boolean, clock?: VideoFrameClock }} options
   */
  constructor({ video, tracker, useVideoFrames = true, clock = new VideoFrameClock() }) {
    this.video = video
    this.tracker = tracker
    this.clock = clock
    this.usesVideoFrames = useVideoFrames && hasVideoFrameCallback(video)
    this.running = false
    this.handle = null
    this.lastPresentedFrames = null
    this.pending = null
    this.stats = { detections: 0, duplicateFrames: 0, skippedFrames: 0 }
    this._onVideoFrame = this._onVideoFrame.bind(this)
  }

  start() {
    if (this.running) return
    this.running = true
    if (this.usesVideoFrames) this._request()
  }

  stop() {
    this.running = false
    if (this.handle != null) this.video.cancelVideoFrameCallback?.(this.handle)
    this.handle = null
    this.pending = null
    this.lastPresentedFrames = null
    this.clock.reset()
  }

  _request() {
    this.handle = this.video.requestVideoFrameCallback(this._onVideoFrame)
  }

  _onVideoFrame(now, metadata = {}) {
    this.handle = null
    if (!this.running) return
    // Ask for the next frame first, so a throw below cannot end the chain.
    this._request()

    const presented = metadata.presentedFrames
    if (presented != null && presented === this.lastPresentedFrames) {
      this.stats.duplicateFrames += 1
      return
    }
    if (presented != null && this.lastPresentedFrames != null && presented > this.lastPresentedFrames + 1) {
      this.stats.skippedFrames += presented - this.lastPresentedFrames - 1
    }
    this.lastPresentedFrames = presented ?? null

    const timestamp = this.clock.stamp(now, metadata)
    this.tracker.detectFrame(this.video, timestamp)
    if (this.tracker.lastDetectionWasFresh) {
      this.stats.detections += 1
      this.pending = { timestamp }
    }
  }

  /**
   * Called once per render. Returns whether a new detection is waiting and the
   * timestamp the pose pipeline should use for this render: the camera frame's
   * own time on a fresh detection, the render time otherwise.
   *
   * `poll` detects inline even in video-frame mode. Harness steppers use it:
   * rVFC, like rAF, does not fire while the page is not being painted.
   *
   * @param {number} renderTimestamp
   * @param {{ poll?: boolean }} [options]
   */
  take(renderTimestamp, { poll = false } = {}) {
    if (!this.usesVideoFrames || poll) {
      this.tracker.detect(this.video, renderTimestamp)
      if (this.tracker.lastDetectionWasFresh) {
        this.stats.detections += 1
        this.pending = null
        return { fresh: true, timestamp: renderTimestamp }
      }
    }
    const pending = this.pending
    this.pending = null
    return pending
      ? { fresh: true, timestamp: Math.min(pending.timestamp, renderTimestamp) }
      : { fresh: false, timestamp: renderTimestamp }
  }
}
