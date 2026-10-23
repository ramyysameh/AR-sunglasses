import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  FILTER_LAYER,
  FILTER_RESIDUAL_MIN,
  LensFilterLayer,
  createLensFilterMesh,
  deriveLensFilter,
  isLensFilterEnabled,
} from '../../src/core/lensFilter.js'

const lens = (color, { transmission = 0, opacity = 1, transparent = false, map = null } = {}) => {
  const m = new THREE.MeshPhysicalMaterial({ color, opacity, transparent, transmission })
  m.map = map
  return m
}

describe('isLensFilterEnabled', () => {
  it('is on unless ?lensfilter=0', () => {
    expect(isLensFilterEnabled('')).toBe(true)
    expect(isLensFilterEnabled('?lensfilter=1')).toBe(true)
    expect(isLensFilterEnabled('?lensfilter=0')).toBe(false)
  })
})

describe('deriveLensFilter', () => {
  it('turns clear orange glass (Orange_Rimless.glb) into an orange filter', () => {
    const m = lens(new THREE.Color().setRGB(1, 0.19, 0.008), { transmission: 0.96 })
    const f = deriveLensFilter(m)
    expect(f).not.toBeNull()
    // background x baseColor x transmission: red passes, blue is cut.
    expect(f.color.r).toBeCloseTo(0.96)
    expect(f.color.g).toBeCloseTo(0.1824)
    expect(f.color.b).toBeCloseTo(0.00768)
    expect(f.residualOpacity).toBe(FILTER_RESIDUAL_MIN)
  })

  it('leaves dark smoke lenses (AI models, transmission ~0.4) on the alpha path', () => {
    const m = lens(new THREE.Color().setRGB(0.052, 0.054, 0.06), { transmission: 0.42 })
    expect(deriveLensFilter(m)).toBeNull()
  })

  it('ignores textured lenses and lenses authored with alpha', () => {
    expect(deriveLensFilter(lens(0xffffff, { transmission: 1, map: new THREE.Texture() }))).toBeNull()
    expect(deriveLensFilter(lens(0xff8800, { transmission: 1, opacity: 0.5, transparent: true }))).toBeNull()
  })

  it('caches on the material, so the shared Lens_L/Lens_R material reads the authored values once', () => {
    const m = lens(new THREE.Color().setRGB(1, 0.19, 0.008), { transmission: 0.96 })
    const first = deriveLensFilter(m)
    m.transmission = 0 // what the loader does right after
    expect(deriveLensFilter(m)).toBe(first)
  })

  it('does not mutate the lens colour', () => {
    const m = lens(new THREE.Color().setRGB(1, 0.5, 0.25), { transmission: 0.6 })
    deriveLensFilter(m)
    expect(m.color.g).toBeCloseTo(0.5)
  })
})

describe('createLensFilterMesh', () => {
  it('is an unlit, untonemapped twin that lives only on the filter layer', () => {
    const lensMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), lens(0xff8800, { transmission: 1 }))
    const twin = createLensFilterMesh(lensMesh, new THREE.Color(1, 0.2, 0))
    expect(twin.geometry).toBe(lensMesh.geometry)
    expect(twin.material.isMeshBasicMaterial).toBe(true)
    expect(twin.material.toneMapped).toBe(false)
    expect(twin.layers.mask).toBe(1 << FILTER_LAYER)
    expect(twin.layers.test(new THREE.Layers())).toBe(false) // main camera (layer 0) never sees it
    expect(twin.castShadow).toBe(false)
  })
})

describe('LensFilterLayer.render', () => {
  const fakeRenderer = () => {
    const calls = []
    return {
      calls,
      getClearColor: (c) => c.set(0x000000),
      getClearAlpha: () => 0,
      setClearColor: (c, a) => calls.push(['clear', a]),
      render: (_s, cam) => calls.push(['render', cam.layers.mask]),
    }
  }

  it('does nothing for a model without filter lenses', () => {
    const r = fakeRenderer()
    const root = new THREE.Group()
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()))
    new LensFilterLayer(null).render(r, new THREE.Scene(), new THREE.PerspectiveCamera(), root)
    expect(r.calls).toEqual([])
  })

  it('does nothing while the glasses are hidden', () => {
    const r = fakeRenderer()
    const root = new THREE.Group()
    const lensMesh = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial())
    lensMesh.add(createLensFilterMesh(lensMesh, new THREE.Color(1, 0, 0)))
    root.add(lensMesh)
    root.visible = false
    new LensFilterLayer(null).render(r, new THREE.Scene(), new THREE.PerspectiveCamera(), root)
    expect(r.calls).toEqual([])
  })
})
