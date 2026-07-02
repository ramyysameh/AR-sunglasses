/**
 * Debug control sidebar: live controls for position, rotation, size and tracking,
 * each with a short description, plus live tracking diagnostics.
 */
import * as THREE from 'three'
import {
  scaleMultiplier,
  setScaleMultiplier,
  setYOffset,
  setXOffset,
  setZOffset,
  setRotOffsetX,
  setRotOffsetY,
  setRotOffsetZ,
  setTrackingSmoothness,
} from '../config/poseConfig.js'

export class DebugHUD {
  constructor() {
    this.root = null
    this.body = null
    this.readout = null
    this.anchorOverlay = null
    this.anchorDots = new Map()
    this._dotSmooth = new Map()
    this.container = null
    this.onParamsChange = null
    this.onFreezeFitChange = null
    this.onOcclusionToggleChange = null
    this.onContactShadowToggleChange = null
    // Kept for API compatibility (RenderLoop adaptive filters mostly override these).
    this.params = {
      positionMinCutoff: 1.0,
      positionBeta: 0.007,
      rotationMinCutoff: 0.5,
      rotationBeta: 0.05,
    }
    // Default values for every control, used by Reset.
    this.defaults = {
      posX: 0, posY: 0, posZ: 0,
      rotX: 0, rotY: 0, rotZ: 0,
      scale: 1.0,
      smoothness: 0.5,
    }
    this.resetters = []
    this.frameCount = 0
    this.lastFpsSample = performance.now()
    this.fps = 0
  }

  async init(container, options = {}) {
    this.container = container
    this.onParamsChange = options.onParamsChange ?? null
    this.params = { ...this.params, ...(options.initialParams ?? {}) }

    this.root = document.createElement('div')
    Object.assign(this.root.style, {
      position: 'absolute', top: '12px', right: '12px', zIndex: '90',
      width: 'min(320px, calc(100vw - 24px))',
      maxHeight: 'calc(100vh - 24px)', overflowY: 'auto',
      padding: '0', borderRadius: '14px',
      background: 'rgba(10, 12, 18, 0.82)',
      backdropFilter: 'blur(14px)', border: '1px solid rgba(255,255,255,0.12)',
      color: '#f3f7ff', font: '12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace',
      pointerEvents: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.45)',
    })

    // --- Header (title + reset + collapse) ---
    const header = document.createElement('div')
    Object.assign(header.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '8px', padding: '12px 14px', position: 'sticky', top: '0',
      background: 'rgba(10,12,18,0.92)', borderBottom: '1px solid rgba(255,255,255,0.1)',
      borderTopLeftRadius: '14px', borderTopRightRadius: '14px',
    })
    const title = document.createElement('div')
    title.textContent = 'Debug Controls'
    Object.assign(title.style, { fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase', color: '#a9ffcf' })

    const btnWrap = document.createElement('div')
    btnWrap.style.display = 'flex'; btnWrap.style.gap = '6px'

    const resetBtn = this._button('Reset', () => this._resetAll())
    const collapseBtn = this._button('–', () => {
      const hidden = this.body.style.display === 'none'
      this.body.style.display = hidden ? 'block' : 'none'
      collapseBtn.textContent = hidden ? '–' : '+'
    })
    btnWrap.append(resetBtn, collapseBtn)
    header.append(title, btnWrap)

    this.body = document.createElement('div')
    this.body.style.padding = '12px 14px'

    this.root.append(header, this.body)
    this.container.appendChild(this.root)

    // anchor dots overlay (tracking debug)
    this.anchorOverlay = document.createElement('div')
    Object.assign(this.anchorOverlay.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '70' })
    this.container.appendChild(this.anchorOverlay)

    // ---------------- SECTIONS ----------------
    const posSec = this._section('Position', 'Move the glasses relative to the face.')
    this._addSlider(posSec, { label: 'Left / Right (X)', desc: 'Slide the glasses sideways across the face.', min: -0.2, max: 0.2, step: 0.001, value: 0, set: setXOffset, key: 'posX' })
    this._addSlider(posSec, { label: 'Up / Down (Y)', desc: 'Raise or lower where the glasses sit on the nose.', min: -0.2, max: 0.2, step: 0.001, value: 0, set: setYOffset, key: 'posY' })
    this._addSlider(posSec, { label: 'Forward / Back (Z)', desc: 'Push the glasses toward or away from the face (depth).', min: -0.3, max: 0.3, step: 0.001, value: 0, set: setZOffset, key: 'posZ' })

    const rotSec = this._section('Rotation', 'Tilt the glasses (degrees), on top of head tracking.')
    this._addSlider(rotSec, { label: 'Pitch (X)', desc: 'Tilt the front up or down.', min: -45, max: 45, step: 0.5, value: 0, set: setRotOffsetX, key: 'rotX', fmt: 1 })
    this._addSlider(rotSec, { label: 'Yaw (Y)', desc: 'Turn the glasses left or right.', min: -45, max: 45, step: 0.5, value: 0, set: setRotOffsetY, key: 'rotY', fmt: 1 })
    this._addSlider(rotSec, { label: 'Roll (Z)', desc: 'Rotate the glasses sideways (lean).', min: -45, max: 45, step: 0.5, value: 0, set: setRotOffsetZ, key: 'rotZ', fmt: 1 })

    const sizeSec = this._section('Size', 'Overall scale of the model.')
    this._addSlider(sizeSec, { label: 'Scale', desc: 'Multiplier on the auto-fit size. 1.0 = automatic fit.', min: 0.3, max: 2.0, step: 0.01, value: 1.0, set: setScaleMultiplier, key: 'scale' })

    const trackSec = this._section('Tracking', 'Tune how the glasses follow your head.')
    this._addSlider(trackSec, { label: 'Smoothness', desc: 'Higher = smoother but more lag. Lower = snappier but more jitter. 0.5 = default.', min: 0, max: 1, step: 0.01, value: 0.5, set: setTrackingSmoothness, key: 'smoothness' })
    this._addCheckbox(trackSec, { label: 'Occlusion', desc: 'Hide parts of the frame that pass behind the face/cheeks.', checked: true, onChange: (c) => this.onOcclusionToggleChange?.(c) })
    this._addCheckbox(trackSec, { label: 'Freeze fit', desc: 'Lock the current face calibration and stop re-scanning.', checked: false, onChange: (c) => this.onFreezeFitChange?.(c) })

    // ---------------- LIVE READOUT ----------------
    const liveSec = this._section('Live diagnostics', 'Read-only — useful for spotting tracking problems.')
    this.readout = document.createElement('div')
    Object.assign(this.readout.style, { whiteSpace: 'pre-wrap', color: '#cfe0ff', fontSize: '11px', lineHeight: '1.5' })
    liveSec.appendChild(this.readout)

    this._emitParams()
    return this
  }

  // ---------- UI helpers ----------
  _button(text, onClick) {
    const b = document.createElement('button')
    b.type = 'button'; b.textContent = text
    Object.assign(b.style, {
      cursor: 'pointer', border: '1px solid rgba(255,255,255,0.18)', borderRadius: '8px',
      background: 'rgba(255,255,255,0.06)', color: '#f3f7ff', font: 'inherit',
      padding: '4px 10px', minWidth: '28px',
    })
    b.addEventListener('click', onClick)
    return b
  }

  _section(titleText, descText) {
    const sec = document.createElement('div')
    sec.style.marginBottom = '16px'
    const t = document.createElement('div')
    t.textContent = titleText
    Object.assign(t.style, { fontWeight: '700', color: '#7fd8ff', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '11px', marginBottom: '2px' })
    const d = document.createElement('div')
    d.textContent = descText
    Object.assign(d.style, { color: 'rgba(243,247,255,0.5)', fontSize: '10.5px', marginBottom: '10px' })
    const grid = document.createElement('div')
    grid.style.display = 'grid'; grid.style.gap = '12px'
    sec.append(t, d, grid)
    this.body.appendChild(sec)
    return grid
  }

  _addSlider(parent, { label, desc, min, max, step, value, set, key, fmt }) {
    const wrap = document.createElement('label')
    wrap.style.display = 'grid'; wrap.style.gap = '4px'

    const head = document.createElement('div')
    Object.assign(head.style, { display: 'flex', justifyContent: 'space-between', gap: '12px' })
    const name = document.createElement('span'); name.textContent = label
    const val = document.createElement('span'); val.style.color = '#a9ffcf'

    const input = document.createElement('input')
    input.type = 'range'; input.min = String(min); input.max = String(max)
    input.step = String(step); input.value = String(value); input.style.width = '100%'

    const decimals = Number.isFinite(fmt) ? fmt : (step < 0.01 ? 3 : (step < 1 ? 2 : 1))
    const apply = () => {
      const v = Number(input.value)
      val.textContent = v.toFixed(decimals)
      set?.(v)
    }
    apply()
    input.addEventListener('input', apply)

    const description = document.createElement('div')
    description.textContent = desc
    Object.assign(description.style, { color: 'rgba(243,247,255,0.45)', fontSize: '10px' })

    head.append(name, val)
    wrap.append(head, input, description)
    parent.appendChild(wrap)

    // register for reset
    if (key && key in this.defaults) {
      this.resetters.push(() => { input.value = String(this.defaults[key]); apply() })
    }
  }

  _addCheckbox(parent, { label, desc, checked, onChange }) {
    const wrap = document.createElement('div')
    wrap.style.display = 'grid'; wrap.style.gap = '2px'
    const row = document.createElement('label')
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' })
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = Boolean(checked)
    const name = document.createElement('span'); name.textContent = label
    input.addEventListener('change', () => onChange?.(input.checked))
    row.append(input, name)
    const description = document.createElement('div')
    description.textContent = desc
    Object.assign(description.style, { color: 'rgba(243,247,255,0.45)', fontSize: '10px', paddingLeft: '24px' })
    wrap.append(row, description)
    parent.appendChild(wrap)
  }

  _resetAll() {
    setXOffset(0); setYOffset(0); setZOffset(0)
    setRotOffsetX(0); setRotOffsetY(0); setRotOffsetZ(0)
    setScaleMultiplier(1.0); setTrackingSmoothness(0.5)
    this.resetters.forEach((fn) => fn())
  }

  // ---------- live readout ----------
  update(data = {}) {
    this.frameCount += 1
    const now = performance.now()
    const elapsed = now - this.lastFpsSample
    if (elapsed >= 500) {
      this.fps = Math.round((this.frameCount * 1000) / elapsed)
      this.frameCount = 0
      this.lastFpsSample = now
    }

    if (!this.readout) return

    const q = data.headQuaternion ?? null
    const euler = new THREE.Euler()
    if (q) euler.setFromQuaternion(q, 'XYZ')
    const pos = data.headPosition ?? null
    const posText = pos ? `${pos.x.toFixed(3)}, ${pos.y.toFixed(3)}, ${pos.z.toFixed(3)}` : 'n/a'

    this.readout.textContent = [
      `FPS: ${this.fps}`,
      `Tracking: ${data.calibrationReady ? 'locked' : (data.localScanStage ?? 'scanning')}`,
      `Pose quality: ${Number(data.poseQuality ?? 0).toFixed(2)}  (1 = best)`,
      `Fit quality: ${Number(data.fitQuality ?? 0).toFixed(2)}`,
      `Filter mode: ${data.filterMode ?? 'n/a'}`,
      `Fit scale: ${Number(data.fitScale ?? 1).toFixed(3)}`,
      `Temple span (px): ${Number(data.templeSpan ?? 0).toFixed(1)}`,
      `Frame depth: ${Number(data.frameDepth ?? 0).toFixed(3)} m`,
      `Head pos: ${posText}`,
      `Yaw ${THREE.MathUtils.radToDeg(euler.y).toFixed(0)}°  Pitch ${THREE.MathUtils.radToDeg(euler.x).toFixed(0)}°  Roll ${THREE.MathUtils.radToDeg(euler.z).toFixed(0)}°`,
    ].join('\n')

    this._updateAnchorOverlay(data.debugPoints)
  }

  _updateAnchorOverlay(points = {}) {
    if (!this.anchorOverlay) return
    const visible = this.root?.style.display !== 'none'
    this.anchorOverlay.style.display = visible ? 'block' : 'none'
    const colors = { bridgeCenter: '#ff4d6d', irisCenter: '#7fd8ff', leftTemple: '#a9ffcf', rightTemple: '#a9ffcf' }
    for (const [key, color] of Object.entries(colors)) {
      let dot = this.anchorDots.get(key)
      if (!dot) {
        dot = document.createElement('div')
        Object.assign(dot.style, {
          position: 'absolute', width: '9px', height: '9px', borderRadius: '50%',
          border: '1px solid rgba(0,0,0,0.65)', boxShadow: '0 0 0 1px rgba(255,255,255,0.65)',
          background: color, transform: 'translate(-50%, -50%)',
        })
        this.anchorOverlay.appendChild(dot)
        this.anchorDots.set(key, dot)
      }
      const p = points?.[key]
      const ok = Number.isFinite(p?.x) && Number.isFinite(p?.y)
      dot.style.display = visible && ok ? 'block' : 'none'
      if (ok) {
        // Light smoothing so the raw per-frame landmark noise doesn't make the
        // marker visibly shake (the glasses are already filtered separately).
        const prev = this._dotSmooth.get(key)
        const sx = prev ? prev.x + (p.x - prev.x) * 0.25 : p.x
        const sy = prev ? prev.y + (p.y - prev.y) * 0.25 : p.y
        this._dotSmooth.set(key, { x: sx, y: sy })
        dot.style.left = `${sx}px`
        dot.style.top = `${sy}px`
      }
    }
  }

  _emitParams() {
    this.onParamsChange?.({ ...this.params })
  }

  setVisible(visible) {
    if (this.root) this.root.style.display = visible ? 'block' : 'none'
    if (this.anchorOverlay) this.anchorOverlay.style.display = visible ? 'block' : 'none'
  }

  setFreezeFitHandler(handler) { this.onFreezeFitChange = handler }
  setOcclusionToggleHandler(handler) { this.onOcclusionToggleChange = handler }
  setContactShadowToggleHandler(handler) { this.onContactShadowToggleChange = handler }
}
