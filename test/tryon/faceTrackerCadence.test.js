import { describe, expect, it, vi } from 'vitest'
import { FaceTracker } from '../../src/tracking/FaceTracker.js'

describe('FaceTracker camera cadence', () => {
  it('runs MediaPipe once per video frame and reuses that target between renders', () => {
    const tracker = new FaceTracker()
    tracker.faceLandmarker = { detectForVideo: vi.fn(() => ({ faceLandmarks: [[]] })) }
    const video = { readyState: 2, currentTime: 1 }

    const first = tracker.detect(video, 10)
    const duplicate = tracker.detect(video, 20)
    expect(duplicate).toBe(first)
    expect(tracker.faceLandmarker.detectForVideo).toHaveBeenCalledTimes(1)
    expect(tracker.lastDetectionWasFresh).toBe(false)

    video.currentTime = 1.033
    tracker.detect(video, 30)
    expect(tracker.faceLandmarker.detectForVideo).toHaveBeenCalledTimes(2)
    expect(tracker.lastDetectionWasFresh).toBe(true)
  })
})
