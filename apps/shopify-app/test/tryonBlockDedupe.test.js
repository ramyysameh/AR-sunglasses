import { readFileSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'

// The shipped block script, extracted from the Liquid rather than retyped, so
// this exercises exactly what merchants get. The script region contains no
// Liquid tags, so it is valid JS as-is.
const liquid = readFileSync(
  new URL('../extensions/tryon-button/blocks/tryon_button.liquid', import.meta.url),
  'utf8',
)
const scriptBody = liquid.slice(
  liquid.indexOf('<script>') + '<script>'.length,
  liquid.indexOf('</script>'),
)

// Minimal stand-ins for the DOM classes the script checks against.
class Element {}
class HTMLButtonElement {}

function makeDialog() {
  return {
    open: false,
    showModal: vi.fn(function () { this.open = true }),
    close: vi.fn(function () { this.open = false }),
  }
}

function makeRoot({ designMode = false, installedUrl = null } = {}) {
  const dialog = makeDialog()
  const dataset = {}
  if (designMode) dataset.arTryonDesignMode = 'true'
  if (installedUrl) dataset.arTryonInstalledUrl = installedUrl
  const root = {
    removed: false,
    innerHTML: '',
    dataset,
    classList: { contains: (c) => c === 'ar-tryon' },
    remove() { this.removed = true },
    querySelector(sel) {
      return sel === '.ar-tryon__dialog' ? dialog : null
    },
    _dialog: dialog,
  }
  // A click on the button's inner <span>/<svg> still resolves via closest().
  root._click = (cls) => {
    const el = Object.assign(new Element(), {
      classList: { contains: (c) => c === cls },
    })
    el.closest = (sel) => (sel.split(', ').includes(`.${cls}`) ? el : sel === '.ar-tryon' ? root : null)
    return el
  }
  return root
}

// One page: a window and document shared by every block script that runs on it.
function makePage({ nativeCommands = false } = {}) {
  const listeners = []
  const Button = class extends HTMLButtonElement {}
  if (nativeCommands) Button.prototype.command = ''
  return {
    window: {},
    Button,
    listeners,
    click(target) { listeners.forEach((fn) => fn({ target })) },
  }
}

// Each block's script runs right after its own markup during parsing, so when
// instance N runs, the DOM holds instances 1..N. `currentScript: null` models a
// script a theme re-inserted after swapping in new section HTML.
function runFor(index, roots, fetch = () => Promise.resolve(), page = makePage(), { currentScript } = {}) {
  const visible = roots.slice(0, index + 1)
  const document = {
    currentScript: currentScript === undefined ? { previousElementSibling: roots[index] } : currentScript,
    querySelectorAll: () => visible,
    addEventListener: (type, fn) => { if (type === 'click') page.listeners.push(fn) },
  }
  new Function('window', 'document', 'fetch', 'Element', 'HTMLButtonElement', scriptBody)(
    page.window, document, fetch, Element, page.Button,
  )
  return page
}

const open = (page, root) => page.click(root._click('ar-tryon__open'))
const close = (page, root) => page.click(root._click('ar-tryon__close'))

describe('try-on block duplicate handling', () => {
  it('wires up the only instance when the block is added once', () => {
    const roots = [makeRoot()]
    runFor(0, roots)

    const page = runFor(0, roots)

    expect(roots[0].removed).toBe(false)
    open(page, roots[0])
    expect(roots[0]._dialog.showModal).toHaveBeenCalledTimes(1)
    close(page, roots[0])
    expect(roots[0]._dialog.close).toHaveBeenCalledTimes(1)
  })

  it('keeps the first instance and removes later ones on the storefront', () => {
    // "Add to theme" deep-links with addAppBlockId, which adds an instance every
    // time it is followed; the admin keeps offering it until someone opens the
    // try-on, so following it twice used to put two buttons on the page.
    const roots = [makeRoot(), makeRoot(), makeRoot()]
    const page = makePage()
    roots.forEach((_, i) => runFor(i, roots, undefined, page))

    expect(roots.map((r) => r.removed)).toEqual([false, true, true])
    // One page-wide listener, not one per instance.
    expect(page.listeners).toHaveLength(1)
  })

  it('reports that the block is on the storefront', () => {
    // The only signal the app gets that setup finished: the engine iframe is
    // lazy and inside a closed <dialog>, so nothing else is fetched until a
    // shopper clicks.
    const fetch = vi.fn(() => Promise.resolve())
    const roots = [makeRoot({ installedUrl: 'https://app.test/api/tryon-installed?shop=s&productId=p' })]
    runFor(0, roots, fetch)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe('https://app.test/api/tryon-installed?shop=s&productId=p')
    expect(fetch.mock.calls[0][1]).toMatchObject({ mode: 'no-cors' })
  })

  it('reports once, not once per duplicated block', () => {
    const fetch = vi.fn(() => Promise.resolve())
    const url = 'https://app.test/api/tryon-installed?shop=s&productId=p'
    const roots = [makeRoot({ installedUrl: url }), makeRoot({ installedUrl: url })]
    roots.forEach((_, i) => runFor(i, roots, fetch))

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not report from the theme editor', () => {
    // Previewing a block is not the same as having published it.
    const fetch = vi.fn(() => Promise.resolve())
    const roots = [makeRoot({ designMode: true })]
    runFor(0, roots, fetch)

    expect(fetch).not.toHaveBeenCalled()
  })

  it('survives a rejected report without breaking the product page', () => {
    const fetch = vi.fn(() => Promise.reject(new Error('blocked')))
    const roots = [makeRoot({ installedUrl: 'https://app.test/api/tryon-installed?shop=s&productId=p' })]

    let page
    expect(() => { page = runFor(0, roots, fetch) }).not.toThrow()
    open(page, roots[0])
    expect(roots[0]._dialog.showModal).toHaveBeenCalled()
  })

  it('explains itself in the theme editor instead of vanishing', () => {
    // A block that silently disappears in the editor reads as a broken app, and
    // the merchant is the only one who can delete the extra block.
    const roots = [makeRoot({ designMode: true }), makeRoot({ designMode: true })]
    roots.forEach((_, i) => runFor(i, roots))

    expect(roots[1].removed).toBe(false)
    expect(roots[1].innerHTML).toContain('more than once')
  })
})

describe('try-on button after the theme swaps in new markup', () => {
  // Belvoir: the button only worked after a refresh. Themes re-render the
  // product section on variant change and some navigate without a full load;
  // the fresh markup's inline script never runs, so a listener bound to the
  // old button left the new one dead.
  it('opens a button whose own script never ran', () => {
    const original = makeRoot()
    const page = runFor(0, [original])

    const rerendered = makeRoot() // new markup, script not executed
    open(page, rerendered)
    expect(rerendered._dialog.showModal).toHaveBeenCalledTimes(1)
  })

  it('still wires clicks when the script runs without currentScript', () => {
    const root = makeRoot()
    const page = runFor(0, [root], undefined, makePage(), { currentScript: null })

    expect(root.removed).toBe(false)
    open(page, root)
    expect(root._dialog.showModal).toHaveBeenCalledTimes(1)
  })

  it('does not stack listeners when a re-inserted script runs again', () => {
    const root = makeRoot()
    const page = runFor(0, [root])
    runFor(0, [root], undefined, page)

    open(page, root)
    expect(page.listeners).toHaveLength(1)
    expect(root._dialog.showModal).toHaveBeenCalledTimes(1)
  })

  it('leaves opening to the browser where Invoker Commands exist', () => {
    // commandfor/command already open the dialog natively; a second
    // showModal from script would be redundant.
    const root = makeRoot()
    const page = runFor(0, [root], undefined, makePage({ nativeCommands: true }))

    open(page, root)
    expect(root._dialog.showModal).not.toHaveBeenCalled()
  })

  it('ties each button to its dialog declaratively', () => {
    expect(liquid).toMatch(/class="ar-tryon__open"[^>]*commandfor="\{\{ dialog_id \}\}" command="show-modal"/)
    expect(liquid).toMatch(/class="ar-tryon__close"[^>]*commandfor="\{\{ dialog_id \}\}" command="close"/)
    expect(liquid).toMatch(/<dialog id="\{\{ dialog_id \}\}"/)
  })
})
