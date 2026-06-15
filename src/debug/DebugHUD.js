/**
 * Debug overlay with live filter controls and tracking diagnostics.
 */
import * as THREE from 'three'
import { scaleMultiplier, setScaleMultiplier, setYOffset, setXOffset, setZOffset } from '../config/poseConfig.js'

export class DebugHUD {
  constructor() {
    this.root = null
    this.controls = null
    this.readout = null
    this.anchorOverlay = null
    this.anchorDots = new Map()
    this.container = null
    this.onParamsChange = null
    this.onFreezeFitChange = null
    this.onOcclusionToggleChange = null
    this.onContactShadowToggleChange = null
    this.params = {
      positionMinCutoff: 1.0,
      positionBeta: 0.007,
      rotationMinCutoff: 0.5,
      rotationBeta: 0.05,
    }
    this.frameCount = 0
    this.lastFpsSample = performance.now()
    this.fps = 0
  }

  async init(container, options = {}) {
    this.container = container
    this.onParamsChange = options.onParamsChange ?? null
    this.params = {
      ...this.params,
      ...(options.initialParams ?? {}),
    }

    this.root = document.createElement('div')
    this.root.style.position = 'absolute'
    this.root.style.top = '12px'
    this.root.style.left = '12px'
    this.root.style.zIndex = '80'
    this.root.style.width = 'min(320px, calc(100vw - 24px))'
    this.root.style.padding = '12px'
    this.root.style.borderRadius = '14px'
    this.root.style.background = 'rgba(10, 12, 18, 0.72)'
    this.root.style.backdropFilter = 'blur(14px)'
    this.root.style.setProperty('-webkit-backdrop-filter', 'blur(14px)')
    this.root.style.border = '1px solid rgba(255, 255, 255, 0.12)'
    this.root.style.color = '#f3f7ff'
    this.root.style.font = '12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace'
    this.root.style.pointerEvents = 'auto'

    const title = document.createElement('div')
    title.textContent = 'AR Debug HUD'
    title.style.fontWeight = '700'
    title.style.letterSpacing = '0.04em'
    title.style.marginBottom = '10px'
    title.style.textTransform = 'uppercase'
    title.style.color = '#a9ffcf'

    this.controls = document.createElement('div')
    this.controls.style.display = 'grid'
    this.controls.style.gap = '10px'

    this.readout = document.createElement('div')
    this.readout.style.marginTop = '12px'
    this.readout.style.paddingTop = '12px'
    this.readout.style.borderTop = '1px solid rgba(255, 255, 255, 0.1)'
    this.readout.style.whiteSpace = 'pre-wrap'

    this.root.append(title, this.controls, this.readout)
    this.container.appendChild(this.root)

    this.anchorOverlay = document.createElement('div')
    this.anchorOverlay.style.position = 'absolute'
    this.anchorOverlay.style.inset = '0'
    this.anchorOverlay.style.pointerEvents = 'none'
    this.anchorOverlay.style.zIndex = '70'
    this.container.appendChild(this.anchorOverlay)

    this._addSlider('Position minCutoff', 'positionMinCutoff', 0.1, 4, 0.01)
    this._addSlider('Position beta', 'positionBeta', 0, 0.05, 0.001)
    this._addSlider('Rotation minCutoff', 'rotationMinCutoff', 0.1, 4, 0.01)
    this._addSlider('Rotation beta', 'rotationBeta', 0, 0.2, 0.001)

    // Fine-tune offsets applied after matrix-based face pose placement.
    this._addNumberInput('Y offset', 'yOffset', -1.0, 1.0, 0.01, 0.0)
    this._addNumberInput('X offset', 'xOffset', -1.0, 1.0, 0.01, 0.0)
    this._addNumberInput('Z offset', 'zOffset', -2.0, 2.0, 0.01, 0.0)
    this._addNumberInput('Scale trim', 'scaleMult', 0.85, 1.15, 0.01, scaleMultiplier)

    this._emitParams()

    // Readouts for canonical metrics (temple/iris/fit/pred)
    this._templeReadout = document.createElement('div')
    this._irisReadout = document.createElement('div')
    this._fitReadout = document.createElement('div')
    this._predReadout = document.createElement('div')
    this._calibrationReadout = document.createElement('div')
    this._qualityReadout = document.createElement('div')

    const readoutsWrap = document.createElement('div')
    readoutsWrap.style.marginTop = '8px'
    readoutsWrap.style.display = 'grid'
    readoutsWrap.style.gap = '4px'
    readoutsWrap.append(
      this._calibrationReadout,
      this._qualityReadout,
      this._templeReadout,
      this._irisReadout,
      this._fitReadout,
      this._predReadout
    )
    this.root.appendChild(readoutsWrap)

    this._addCheckbox('Freeze fit profile', 'freezeFit', false, (checked) => {
      this.onFreezeFitChange?.(checked)
    })
    this._addCheckbox('Show occlusion mesh', 'occlusionEnabled', true, (checked) => {
      this.onOcclusionToggleChange?.(checked)
    })
    this._addCheckbox('Contact shadow', 'contactShadowEnabled', true, (checked) => {
      this.onContactShadowToggleChange?.(checked)
    })

    return this
  }

  _addSlider(labelText, key, min, max, step) {
    const wrap = document.createElement('label')
    wrap.style.display = 'grid'
    wrap.style.gap = '6px'

    const header = document.createElement('div')
    header.style.display = 'flex'
    header.style.justifyContent = 'space-between'
    header.style.gap = '12px'

    const label = document.createElement('span')
    label.textContent = labelText

    const value = document.createElement('span')
    value.style.color = '#7fd8ff'

    const input = document.createElement('input')
    input.type = 'range'
    input.min = String(min)
    input.max = String(max)
    input.step = String(step)
    input.value = String(this.params[key])
    input.style.width = '100%'

    const updateValue = () => {
      this.params[key] = Number(input.value)
      value.textContent = Number(input.value).toFixed(step < 0.01 ? 3 : 2)
      this._emitParams()
    }

    updateValue()
    input.addEventListener('input', updateValue)

    header.append(label, value)
    wrap.append(header, input)
    this.controls.appendChild(wrap)
  }

  _addNumberInput(labelText, key, min, max, step, defaultValue) {
    const wrap = document.createElement('label')
    wrap.style.display = 'grid'
    wrap.style.gap = '6px'

    const header = document.createElement('div')
    header.style.display = 'flex'
    header.style.justifyContent = 'space-between'
    header.style.gap = '12px'

    const label = document.createElement('span')
    label.textContent = labelText

    const input = document.createElement('input')
    input.type = 'number'
    input.min = String(min)
    input.max = String(max)
    input.step = String(step)
    input.value = String(defaultValue)
    input.style.width = '100%'

    const update = () => {
      const v = Number(input.value)
      if (key === 'yOffset') setYOffset(v)
      else if (key === 'xOffset') setXOffset(v)
      else if (key === 'zOffset') setZOffset(v)
      else if (key === 'scaleMult') setScaleMultiplier(parseFloat(input.value))
    }

    input.addEventListener('input', update)
    input.addEventListener('change', update)

    header.append(label, input)
    wrap.append(header)
    this.controls.appendChild(wrap)
  }

  _addCheckbox(labelText, key, defaultValue, onChange) {
    const wrap = document.createElement('label')
    wrap.style.display = 'flex'
    wrap.style.alignItems = 'center'
    wrap.style.gap = '8px'

    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = Boolean(defaultValue)

    const label = document.createElement('span')
    label.textContent = labelText

    input.addEventListener('change', () => {
      this.params[key] = input.checked
      onChange?.(input.checked)
    })

    wrap.append(input, label)
    this.controls.appendChild(wrap)
  }

  update(data = {}) {
    this.frameCount += 1

    const now = performance.now()
    const elapsed = now - this.lastFpsSample
    if (elapsed >= 500) {
      this.fps = Math.round((this.frameCount * 1000) / elapsed)
      this.frameCount = 0
      this.lastFpsSample = now
    }

    const quaternion = data.headQuaternion ?? null
    const euler = new THREE.Euler()
    if (quaternion) {
      euler.setFromQuaternion(quaternion, 'XYZ')
    }

    const position = data.headPosition ?? null
    const positionText = position
      ? `${position.x.toFixed(3)}, ${position.y.toFixed(3)}, ${position.z.toFixed(3)}`
      : 'n/a'

    this.readout.textContent = [
      `FPS: ${this.fps}`,
      `Face scan: ${data.calibrationReady ? 'ready' : data.localScanStage ?? 'sampling'}`,
      `Pose quality: ${Number(data.poseQuality ?? 0).toFixed(2)}`,
      `Fit quality: ${Number(data.fitQuality ?? data.surfaceQuality ?? 0).toFixed(2)}`,
      `Frame depth: ${Number(data.frameDepth ?? 0).toFixed(3)}`,
      `Surface depth: ${Number(data.surfaceDepth ?? 0).toFixed(3)}`,
      `Bridge clearance: ${Number(data.bridgeClearance ?? 0).toFixed(3)}m`,
      `Filter mode: ${data.filterMode ?? 'n/a'}`,
      `Tracking delta: ${Number(data.trackingDelta ?? 0).toFixed(3)}`,
      `Temple span (px): ${Number(data.templeSpan ?? 0).toFixed(1)}`,
      `Fit scale: ${Number(data.fitScale ?? 1).toFixed(3)}`,
      `Raw fit scale: ${Number(data.rawFitScale ?? data.fitScale ?? 1).toFixed(3)}`,
      `Frame width: ${Number(data.frameWidthMeters ?? 0).toFixed(3)}m`,
      `Model width: raw ${Number(data.rawModelWidth ?? 0).toFixed(3)} / normalized ${Number(data.normalizedModelWidth ?? 0).toFixed(3)}`,
      `Model depth: ${Number(data.modelDepth ?? 0).toFixed(3)} (${data.depthPivot ?? 'n/a'})`,
      `Nose bridge Z: ${Number(data.noseBridgeZ ?? 0).toFixed(3)}`,
      `Head pos: ${positionText}`,
      `Yaw: ${(THREE.MathUtils.radToDeg(euler.y)).toFixed(1)} deg`,
      `Pitch: ${(THREE.MathUtils.radToDeg(euler.x)).toFixed(1)} deg`,
      `Roll: ${(THREE.MathUtils.radToDeg(euler.z)).toFixed(1)} deg`,
    ].join('\n')

    const temple = Number(data.templeSpan ?? 0).toFixed(4)
    const iris = Number(data.irisSpan ?? 0).toFixed(4)
    const fit = Number(data.fitScale ?? 0).toFixed(4)
    const pred = Number(data.predictionDelta ?? 0).toFixed(4)
    const calibrationProgress = Number(data.calibrationProgress ?? 0)
    const calibrationSamples = Number(data.calibrationSamples ?? 0)
    const calibrationTarget = Number(data.calibrationTarget ?? 0)
    const poseQuality = Number(data.poseQuality ?? 0).toFixed(2)

    if (this._calibrationReadout) {
      this._calibrationReadout.textContent = data.calibrationReady
        ? `Calibration: ready${data.fitFrozen ? ' (frozen)' : ''}`
        : `Scan ${data.localScanStage ?? 'sampling'}: ${calibrationSamples}/${calibrationTarget} ${(calibrationProgress * 100).toFixed(0)}%`
    }
    if (this._qualityReadout) this._qualityReadout.textContent = `Pose quality: ${poseQuality}`
    if (this._templeReadout) this._templeReadout.textContent = `Temple span: ${temple}`
    if (this._irisReadout) this._irisReadout.textContent = `Iris span:   ${iris}`
    if (this._fitReadout) this._fitReadout.textContent = `Fit scale:   ${fit}`
    if (this._predReadout) this._predReadout.textContent = `Pred delta:  ${pred}`

    this._updateAnchorOverlay(data.debugPoints)
  }

  _updateAnchorOverlay(points = {}) {
    if (!this.anchorOverlay) {
      return
    }

    const visible = this.root?.style.display !== 'none'
    this.anchorOverlay.style.display = visible ? 'block' : 'none'

    const colors = {
      bridgeCenter: '#ff4d6d',
      irisCenter: '#7fd8ff',
      leftTemple: '#a9ffcf',
      rightTemple: '#a9ffcf',
    }

    for (const [key, color] of Object.entries(colors)) {
      let dot = this.anchorDots.get(key)
      if (!dot) {
        dot = document.createElement('div')
        dot.style.position = 'absolute'
        dot.style.width = '9px'
        dot.style.height = '9px'
        dot.style.borderRadius = '50%'
        dot.style.border = '1px solid rgba(0, 0, 0, 0.65)'
        dot.style.boxShadow = '0 0 0 1px rgba(255, 255, 255, 0.65)'
        dot.style.background = color
        dot.style.transform = 'translate(-50%, -50%)'
        this.anchorOverlay.appendChild(dot)
        this.anchorDots.set(key, dot)
      }

      const point = points?.[key]
      const isFinitePoint = Number.isFinite(point?.x) && Number.isFinite(point?.y)
      dot.style.display = visible && isFinitePoint ? 'block' : 'none'

      if (isFinitePoint) {
        dot.style.left = `${point.x}px`
        dot.style.top = `${point.y}px`
      }
    }
  }

  _emitParams() {
    this.onParamsChange?.({ ...this.params })
  }

  setVisible(visible) {
    if (this.root) {
      this.root.style.display = visible ? 'block' : 'none'
    }

    if (this.anchorOverlay) {
      this.anchorOverlay.style.display = visible ? 'block' : 'none'
    }
  }

  setFreezeFitHandler(handler) {
    this.onFreezeFitChange = handler
  }

  setOcclusionToggleHandler(handler) {
    this.onOcclusionToggleChange = handler
  }

  setContactShadowToggleHandler(handler) {
    this.onContactShadowToggleChange = handler
  }

}
