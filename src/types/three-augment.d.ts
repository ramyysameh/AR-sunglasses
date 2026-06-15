import 'three'

// The render loop caches the canvas pixel dimensions on the camera so the fit
// solvers can reason in pixel space. Declare them so checkJs accepts the access.
declare module 'three' {
  interface PerspectiveCamera {
    _pixelWidth?: number
    _pixelHeight?: number
  }
}
