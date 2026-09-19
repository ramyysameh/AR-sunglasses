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

function makeRoot({ designMode = false } = {}) {
  const open = { addEventListener: vi.fn() }
  const close = { addEventListener: vi.fn() }
  const dialog = { showModal: vi.fn(), close: vi.fn() }
  return {
    removed: false,
    innerHTML: '',
    dataset: designMode ? { arTryonDesignMode: 'true' } : {},
    remove() { this.removed = true },
    querySelector(sel) {
      if (sel === '.ar-tryon__dialog') return dialog
      if (sel === '.ar-tryon__open') return open
      if (sel === '.ar-tryon__close') return close
      return null
    },
    _open: open,
  }
}

// Each block's script runs right after its own markup during parsing, so when
// instance N runs, the DOM holds instances 1..N.
function runFor(index, roots) {
  const visible = roots.slice(0, index + 1)
  const document = {
    currentScript: { previousElementSibling: roots[index] },
    querySelectorAll: () => visible,
  }
  new Function('document', scriptBody)(document)
}

describe('try-on block duplicate handling', () => {
  it('wires up the only instance when the block is added once', () => {
    const roots = [makeRoot()]
    runFor(0, roots)

    expect(roots[0].removed).toBe(false)
    expect(roots[0]._open.addEventListener).toHaveBeenCalledWith('click', expect.any(Function))
  })

  it('keeps the first instance and removes later ones on the storefront', () => {
    // "Add to theme" deep-links with addAppBlockId, which adds an instance every
    // time it is followed; the admin keeps offering it until someone opens the
    // try-on, so following it twice used to put two buttons on the page.
    const roots = [makeRoot(), makeRoot(), makeRoot()]
    roots.forEach((_, i) => runFor(i, roots))

    expect(roots.map((r) => r.removed)).toEqual([false, true, true])
    expect(roots[0]._open.addEventListener).toHaveBeenCalled()
    expect(roots[1]._open.addEventListener).not.toHaveBeenCalled()
  })

  it('explains itself in the theme editor instead of vanishing', () => {
    // A block that silently disappears in the editor reads as a broken app, and
    // the merchant is the only one who can delete the extra block.
    const roots = [makeRoot({ designMode: true }), makeRoot({ designMode: true })]
    roots.forEach((_, i) => runFor(i, roots))

    expect(roots[1].removed).toBe(false)
    expect(roots[1].innerHTML).toContain('more than once')
    expect(roots[1]._open.addEventListener).not.toHaveBeenCalled()
  })
})
