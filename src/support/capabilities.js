/**
 * Environment capability checks and human-friendly error mapping for the
 * WebAR try-on. These run before we touch the camera so users get a clear,
 * actionable message instead of a raw DOMException.
 */

/**
 * @typedef {Object} CapabilityResult
 * @property {boolean} ok        Whether the environment can run the try-on.
 * @property {string} [reason]   Machine-readable reason code when not ok.
 * @property {string} [message]  User-facing explanation when not ok.
 * @property {boolean} [recoverable] Whether retrying might succeed.
 */

function hasWebGL() {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(
      window.WebGLRenderingContext &&
      (canvas.getContext('webgl2') || canvas.getContext('webgl'))
    )
  } catch {
    return false
  }
}

/**
 * Checks that the browser can run the try-on at all, independent of whether the
 * user has granted camera permission yet.
 * @returns {CapabilityResult}
 */
export function checkEnvironment() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { ok: false, reason: 'no-window', message: 'This environment cannot run the try-on.' }
  }

  // getUserMedia requires a secure context (HTTPS), except on localhost.
  if (!window.isSecureContext) {
    return {
      ok: false,
      reason: 'insecure-context',
      message: 'The try-on needs a secure (HTTPS) connection to use your camera.',
    }
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      ok: false,
      reason: 'no-getusermedia',
      message: 'Your browser does not support camera access. Try the latest Chrome, Safari, or Edge.',
    }
  }

  if (!hasWebGL()) {
    return {
      ok: false,
      reason: 'no-webgl',
      message: 'Your browser or device does not support 3D graphics (WebGL) needed for the try-on.',
    }
  }

  return { ok: true }
}

/**
 * Translates a getUserMedia / camera failure into a friendly, actionable message.
 * @param {unknown} error
 * @returns {CapabilityResult}
 */
export function describeCameraError(error) {
  const name = (error && typeof error === 'object' && 'name' in error)
    ? String(/** @type {{name: unknown}} */ (error).name)
    : ''

  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        ok: false,
        reason: 'permission-denied',
        recoverable: true,
        message: 'Camera access was blocked. Allow camera permission in your browser, then tap Retry.',
      }
    case 'NotFoundError':
    case 'OverconstrainedError':
      return {
        ok: false,
        reason: 'no-camera',
        recoverable: true,
        message: 'No usable camera was found. Connect a front-facing camera and tap Retry.',
      }
    case 'NotReadableError':
    case 'AbortError':
      return {
        ok: false,
        reason: 'camera-busy',
        recoverable: true,
        message: 'Your camera is being used by another app. Close it, then tap Retry.',
      }
    default:
      return {
        ok: false,
        reason: 'camera-error',
        recoverable: true,
        message: 'We could not start your camera. Check your settings and tap Retry.',
      }
  }
}

/**
 * Wraps a raw getUserMedia rejection so callers can surface a friendly message
 * while preserving the original error for logging.
 */
export class CameraError extends Error {
  /** @param {CapabilityResult} info @param {unknown} cause */
  constructor(info, cause) {
    super(info.message)
    this.name = 'CameraError'
    this.reason = info.reason
    this.recoverable = info.recoverable ?? false
    this.cause = cause
  }
}
