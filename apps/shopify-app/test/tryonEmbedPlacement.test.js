import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const liquid = readFileSync(new URL('../extensions/tryon-button/blocks/tryon_embed.liquid', import.meta.url), 'utf8')
const scriptBody = liquid.slice(liquid.indexOf('<script>') + '<script>'.length, liquid.indexOf('</script>'))

// A root the way the script sees it: classes tracked, moves recorded on the
// anchor it is inserted after.
function makeRoot({ designMode = false } = {}) {
  const classes = new Set()
  return {
    isConnected: true,
    dataset: designMode ? { arTryonDesignMode: 'true' } : {},
    classes,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
  }
}

// `payment` puts a Buy now wrapper either inside the submit's form ('form') or
// beside it under a shared ancestor ('ancestor'); `paymentParentDisplay` is the
// display of the wrapper's parent row.
function makeSubmit(parentDisplay, { payment, paymentParentDisplay = 'block' } = {}) {
  const calls = []
  const paymentRow = { display: paymentParentDisplay, insertAdjacentElement: (where, el) => calls.push(['paymentRow', where, el]) }
  const paymentButton = payment
    ? { parentElement: paymentRow, insertAdjacentElement: (where, el) => calls.push(['payment', where, el]) }
    : null
  const find = (sel) => (sel.includes('shopify-payment-button') ? paymentButton : null)
  const grandparent = { querySelector: payment === 'ancestor' ? find : () => null, parentElement: null }
  const parent = {
    display: parentDisplay,
    calls,
    parentElement: grandparent,
    querySelector: () => null,
    insertAdjacentElement: (where, el) => calls.push(['parent', where, el]),
  }
  const form = { querySelector: payment === 'form' ? find : () => null }
  return {
    calls,
    parent,
    parentElement: parent,
    form,
    closest: () => form,
    insertAdjacentElement: (where, el) => calls.push(['submit', where, el]),
  }
}

// `state.submit` is read at call time so a test can swap in a re-rendered form.
function run(state, { MutationObserver, requestAnimationFrame, getComputedStyle } = {}) {
  const document = {
    body: { appendChild: (el) => { state.appended = el } },
    querySelector: (sel) => (sel.includes('data-ar-tryon-placement') ? state.root : sel.includes('/cart/add') ? state.submit : null),
  }
  new Function('document', 'MutationObserver', 'requestAnimationFrame', 'getComputedStyle', scriptBody)(
    document, MutationObserver, requestAnimationFrame, getComputedStyle,
  )
  return document
}

function makeObserver() {
  const created = []
  class FakeObserver {
    constructor(cb) { this.cb = cb; this.target = null; this.options = null; created.push(this) }
    observe(target, options) { this.target = target; this.options = options }
  }
  return { FakeObserver, created }
}

describe('embed placement', () => {
  it('has Liquid-free first script', () => {
    expect(scriptBody).not.toMatch(/\{%|\{\{/)
  })

  it('puts the button right after Add to cart when there is no Buy now', () => {
    const root = makeRoot()
    const submit = makeSubmit('block')
    run({ root, submit })
    expect(submit.calls).toEqual([['submit', 'afterend', root]])
    expect(root.classes.has('ar-tryon--floating')).toBe(false)
  })

  it('goes after a flex row so the full-width button gets its own line', () => {
    const root = makeRoot()
    const submit = makeSubmit('flex')
    run({ root, submit }, { getComputedStyle: (el) => ({ display: el.display }) })
    expect(submit.calls).toEqual([['parent', 'afterend', root]])
  })

  it('puts the button below Buy now when the form has one', () => {
    const root = makeRoot()
    const submit = makeSubmit('block', { payment: 'form' })
    run({ root, submit })
    expect(submit.calls).toEqual([['payment', 'afterend', root]])
  })

  it('goes after the row when Add to cart and Buy now sit side by side', () => {
    const root = makeRoot()
    const submit = makeSubmit('block', { payment: 'form', paymentParentDisplay: 'flex' })
    run({ root, submit }, { getComputedStyle: (el) => ({ display: el.display }) })
    expect(submit.calls).toEqual([['paymentRow', 'afterend', root]])
  })

  it('finds a Buy now that sits outside the form but near Add to cart', () => {
    const root = makeRoot()
    const submit = makeSubmit('block', { payment: 'ancestor' })
    run({ root, submit })
    expect(submit.calls).toEqual([['payment', 'afterend', root]])
  })

  it('falls back to the submit button when getComputedStyle is unavailable', () => {
    const root = makeRoot()
    const submit = makeSubmit('flex')
    run({ root, submit })
    expect(submit.calls).toEqual([['submit', 'afterend', root]])
  })

  it('floats the button when the theme has no Add to cart form', () => {
    const root = makeRoot()
    run({ root, submit: null })
    expect([...root.classes]).toEqual(['ar-tryon--floating'])
  })

  it('does nothing when the block already won', () => {
    expect(() => run({ root: null, submit: null })).not.toThrow()
  })

  it('places once and does not observe when MutationObserver is missing', () => {
    const root = makeRoot()
    const submit = makeSubmit('block')
    expect(() => run({ root, submit })).not.toThrow()
    expect(submit.calls).toHaveLength(1)
  })

  it('floats in the theme editor instead of moving into the form, and does not observe', () => {
    const root = makeRoot({ designMode: true })
    const submit = makeSubmit('block')
    const { FakeObserver, created } = makeObserver()
    run({ root, submit }, { MutationObserver: FakeObserver })
    expect(submit.calls).toEqual([])
    expect([...root.classes]).toEqual(['ar-tryon--floating'])
    expect(created).toHaveLength(0)
  })
})

describe('embed re-placement after the theme re-renders', () => {
  it('observes body for added/removed nodes', () => {
    const { FakeObserver, created } = makeObserver()
    run({ root: makeRoot(), submit: makeSubmit('block') }, { MutationObserver: FakeObserver, requestAnimationFrame: (f) => f() })
    expect(created).toHaveLength(1)
    expect(created[0].options).toEqual({ childList: true, subtree: true })
    expect(created[0].target).toBeTruthy()
  })

  it('re-inserts after the new Add to cart once the root was destroyed', () => {
    const { FakeObserver, created } = makeObserver()
    const root = makeRoot()
    const first = makeSubmit('block')
    const state = { root, submit: first }
    run(state, { MutationObserver: FakeObserver, requestAnimationFrame: (f) => f() })

    // The theme swaps the form: old root is gone, a fresh submit exists.
    root.isConnected = false
    const second = makeSubmit('block')
    state.submit = second
    created[0].cb()

    expect(second.calls).toEqual([['submit', 'afterend', root]])
  })

  it('does nothing while the root is still connected', () => {
    const { FakeObserver, created } = makeObserver()
    const root = makeRoot()
    const first = makeSubmit('block')
    const state = { root, submit: first }
    run(state, { MutationObserver: FakeObserver, requestAnimationFrame: (f) => f() })
    const second = makeSubmit('block')
    state.submit = second

    created[0].cb()
    expect(first.calls).toHaveLength(1)
    expect(second.calls).toEqual([])
  })

  it('throttles to one pending frame at a time', () => {
    const { FakeObserver, created } = makeObserver()
    const root = makeRoot()
    const state = { root, submit: makeSubmit('block') }
    const frames = []
    run(state, { MutationObserver: FakeObserver, requestAnimationFrame: (f) => frames.push(f) })

    root.isConnected = false
    const second = makeSubmit('block')
    state.submit = second
    created[0].cb()
    created[0].cb()
    created[0].cb()
    expect(frames).toHaveLength(1)

    frames[0]()
    expect(second.calls).toHaveLength(1)
  })

  it('skips the re-place if the root came back before the frame fired', () => {
    const { FakeObserver, created } = makeObserver()
    const root = makeRoot()
    const state = { root, submit: makeSubmit('block') }
    const frames = []
    run(state, { MutationObserver: FakeObserver, requestAnimationFrame: (f) => frames.push(f) })

    root.isConnected = false
    const second = makeSubmit('block')
    state.submit = second
    created[0].cb()
    root.isConnected = true
    frames[0]()
    expect(second.calls).toEqual([])
  })

  it('re-attaches a floating root to body when the theme dropped it and there is no form', () => {
    const { FakeObserver, created } = makeObserver()
    const root = makeRoot()
    const state = { root, submit: null }
    run(state, { MutationObserver: FakeObserver, requestAnimationFrame: (f) => f() })
    root.isConnected = false
    created[0].cb()
    expect(state.appended).toBe(root)
  })
})

describe('embed placement never throws on the storefront', () => {
  const throwing = () => { throw new Error('theme broke querySelector') }

  it('swallows a throwing querySelector during the first placement', () => {
    const state = { root: makeRoot() }
    Object.defineProperty(state, 'submit', { get: throwing })
    expect(() => run(state)).not.toThrow()
  })

  it('swallows an error while placing inside the observer callback', () => {
    const { FakeObserver, created } = makeObserver()
    const root = makeRoot()
    const state = { root, submit: makeSubmit('block') }
    run(state, { MutationObserver: FakeObserver, requestAnimationFrame: (f) => f() })
    root.isConnected = false
    Object.defineProperty(state, 'submit', { get: throwing })
    expect(() => created[0].cb()).not.toThrow()
  })

  it('swallows a failing insert', () => {
    const root = makeRoot()
    const submit = makeSubmit('block')
    submit.insertAdjacentElement = throwing
    expect(() => run({ root, submit })).not.toThrow()
  })
})
