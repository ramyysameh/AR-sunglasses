import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { DetectionScheduler, VideoFrameClock } from '../../src/tracking/DetectionScheduler.js'
import { FaceTracker } from '../../src/tracking/FaceTracker.js'
import { PoseInterpolator } from '../../src/tracking/PoseInterpolator.js'
import { RenderLoop } from '../../src/core/RenderLoop.js'

const FRAME_MS = 1000 / 30

function fakeTracker() {
  const tracker = new FaceTracker()
  tracker.faceLandmarker = { detectForVideo: vi.fn(() => ({ faceLandmarks: [[]] })) }
  return tracker
}

/** A video element whose rVFC callbacks the test fires by hand. */
function fakeVideo({ rvfc = true } = {}) {
  const video = { readyState: 4, currentTime: 0, callbacks: new Map(), nextHandle: 1 }
  if (rvfc) {
    video.requestVideoFrameCallback = (cb) => {
      const handle = video.nextHandle++
      video.callbacks.set(handle, cb)
      return handle
    }
    video.cancelVideoFrameCallback = vi.fn((handle) => video.callbacks.delete(handle))
    /** Presents one frame: runs every callback registered before it. */
    video.present = (now, metadata) => {
      if (metadata.mediaTime != null) video.currentTime = metadata.mediaTime
      const due = [...video.callbacks.values()]
      video.callbacks.clear()
      for (const cb of due) cb(now, metadata)
    }
  }
  return video
}

describe('DetectionScheduler on requestVideoFrameCallback', () => {
  it('detects once per presented frame and hands each to one render', () => {
    const tracker = fakeTracker()
    const video = fakeVideo()
    const scheduler = new DetectionScheduler({ video, tracker })
    scheduler.start()
    expect(scheduler.usesVideoFrames).toBe(true)

    // Renders never detect on their own in this mode.
    expect(scheduler.take(5)).toEqual({ fresh: false, timestamp: 5 })
    expect(tracker.faceLandmarker.detectForVideo).not.toHaveBeenCalled()

    video.present(100, { presentedFrames: 1, mediaTime: 0 })
    expect(tracker.faceLandmarker.detectForVideo).toHaveBeenCalledTimes(1)
    expect(scheduler.take(110)).toEqual({ fresh: true, timestamp: 100 })
    // The next render of the same frame reuses it.
    expect(scheduler.take(126)).toEqual({ fresh: false, timestamp: 126 })
    expect(tracker.faceLandmarker.detectForVideo).toHaveBeenCalledTimes(1)
  })

  it('never detects the same presented frame twice', () => {
    const tracker = fakeTracker()
    const video = fakeVideo()
    const scheduler = new DetectionScheduler({ video, tracker })
    scheduler.start()

    video.present(100, { presentedFrames: 7, mediaTime: 1 })
    video.present(116, { presentedFrames: 7, mediaTime: 1 })
    expect(tracker.faceLandmarker.detectForVideo).toHaveBeenCalledTimes(1)
    expect(scheduler.stats.duplicateFrames).toBe(1)

    video.present(133, { presentedFrames: 9, mediaTime: 1 + 2 * FRAME_MS / 1000 })
    expect(tracker.faceLandmarker.detectForVideo).toHaveBeenCalledTimes(2)
    expect(scheduler.stats.skippedFrames).toBe(1)
  })

  it('passes the camera frame times through to MediaPipe and the tracker cadence', () => {
    const tracker = fakeTracker()
    const video = fakeVideo()
    const scheduler = new DetectionScheduler({ video, tracker })
    scheduler.start()

    // Callbacks land on vsync with jitter; the frames themselves are 30 fps.
    const nows = [100, 150, 167, 216, 240]
    nows.forEach((now, i) => {
      video.present(now, { presentedFrames: i + 1, mediaTime: 5 + i * FRAME_MS / 1000, expectedDisplayTime: now + 16.7 })
      scheduler.take(now + 2)
    })
    const stamps = tracker.faceLandmarker.detectForVideo.mock.calls.map(([, ts]) => ts)
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i] - stamps[i - 1]).toBeCloseTo(FRAME_MS, 0)
      // Never later than the callback that delivered the frame.
      expect(stamps[i]).toBeLessThanOrEqual(nows[i])
    }
    expect(tracker.frameIntervalMs).toBeCloseTo(FRAME_MS, 1)
  })

  it('does not double-detect a frame a harness poll already took', () => {
    const tracker = fakeTracker()
    const video = fakeVideo()
    const scheduler = new DetectionScheduler({ video, tracker })
    scheduler.start()

    video.currentTime = 2
    expect(scheduler.take(100, { poll: true }).fresh).toBe(true)
    video.present(101, { presentedFrames: 1, mediaTime: 2 })
    expect(tracker.faceLandmarker.detectForVideo).toHaveBeenCalledTimes(1)
    expect(scheduler.take(102).fresh).toBe(false)

    // ...and a poll after the callback took the frame does not detect it again.
    video.present(134, { presentedFrames: 2, mediaTime: 2 + FRAME_MS / 1000 })
    expect(scheduler.take(135, { poll: true }).fresh).toBe(true)
    expect(tracker.faceLandmarker.detectForVideo).toHaveBeenCalledTimes(2)
  })

  it('stops asking for frames once stopped', () => {
    const tracker = fakeTracker()
    const video = fakeVideo()
    const scheduler = new DetectionScheduler({ video, tracker })
    scheduler.start()
    scheduler.stop()
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledTimes(1)
    expect(video.callbacks.size).toBe(0)
  })
})

describe('DetectionScheduler fallback', () => {
  it('detects inline from the render step when the video has no rVFC', () => {
    const tracker = fakeTracker()
    const video = fakeVideo({ rvfc: false })
    const scheduler = new DetectionScheduler({ video, tracker })
    scheduler.start()
    expect(scheduler.usesVideoFrames).toBe(false)

    video.currentTime = 1
    expect(scheduler.take(10)).toEqual({ fresh: true, timestamp: 10 })
    expect(scheduler.take(26)).toEqual({ fresh: false, timestamp: 26 })
    video.currentTime = 1 + FRAME_MS / 1000
    expect(scheduler.take(43)).toEqual({ fresh: true, timestamp: 43 })
    expect(tracker.faceLandmarker.detectForVideo.mock.calls.map(([, ts]) => ts)).toEqual([10, 43])
  })

  it('stays on the render path when rVFC is turned off (?rvfc=0)', () => {
    const tracker = fakeTracker()
    const video = fakeVideo()
    const scheduler = new DetectionScheduler({ video, tracker, useVideoFrames: false })
    scheduler.start()
    expect(scheduler.usesVideoFrames).toBe(false)
    expect(video.callbacks.size).toBe(0)
    video.currentTime = 3
    expect(scheduler.take(10).fresh).toBe(true)
  })
})

describe('VideoFrameClock', () => {
  it('re-anchors when the media clock jumps back (a new source)', () => {
    const clock = new VideoFrameClock()
    expect(clock.stamp(1000, { mediaTime: 10 })).toBe(1000)
    expect(clock.stamp(1040, { mediaTime: 10 + FRAME_MS / 1000 })).toBeCloseTo(1000 + FRAME_MS, 0)
    // New camera: its media timeline starts over.
    expect(clock.stamp(2000, { mediaTime: 0 })).toBe(2000)
  })

  it('re-anchors after a long stall instead of lagging behind it', () => {
    const clock = new VideoFrameClock()
    clock.stamp(1000, { mediaTime: 0 })
    expect(clock.stamp(1600, { mediaTime: FRAME_MS / 1000 })).toBe(1600)
  })

  it('stays strictly increasing and falls back without mediaTime', () => {
    const clock = new VideoFrameClock()
    expect(clock.stamp(100, { expectedDisplayTime: 116 })).toBe(100)
    expect(clock.stamp(100, {})).toBe(101)
  })
})

describe('RenderLoop renders between detections', () => {
  it('redraws the interpolated pose without re-running the pose pipeline', () => {
    const loop = new RenderLoop({ profileGuard: null })
    loop.scene = new THREE.Scene()
    loop.glassesRoot = new THREE.Group()
    loop.scene.add(loop.glassesRoot)
    loop._syncSize = () => {}
    loop._render = vi.fn()
    loop._applyTransform = vi.fn()
    loop.positionFilter = { filter: vi.fn() }
    loop.landmarkProcessor = { processLandmarks: vi.fn() }
    loop.faceTracker = fakeTracker()
    loop.video = fakeVideo()
    loop.poseInterpolator = new PoseInterpolator()
    const q = new THREE.Quaternion()
    loop.poseInterpolator.push(new THREE.Vector3(0, 0, 0), q, 0, FRAME_MS)
    loop.poseInterpolator.push(new THREE.Vector3(1, 0, 0), q, FRAME_MS, FRAME_MS)
    loop._displayFrame = {
      glassesRoot: loop.glassesRoot,
      tunedPosition: new THREE.Vector3(1, 0, 0),
      solvedQuaternion: q.clone(),
      solvedScale: 1,
      fitScale: 1,
    }

    const now = vi.spyOn(performance, 'now').mockReturnValue(FRAME_MS * 1.5)
    loop._step()
    now.mockRestore()

    expect(loop.faceTracker.faceLandmarker.detectForVideo).not.toHaveBeenCalled()
    expect(loop.landmarkProcessor.processLandmarks).not.toHaveBeenCalled()
    expect(loop.positionFilter.filter).not.toHaveBeenCalled()
    expect(loop._applyTransform).toHaveBeenCalledTimes(1)
    expect(loop._applyTransform.mock.calls[0][0].position.x).toBeCloseTo(1)
    expect(loop._render).toHaveBeenCalledTimes(1)
    loop.stop()
  })
})
