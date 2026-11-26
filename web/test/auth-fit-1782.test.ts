import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #1782: /sign-up scrolled at 1440x900 and the auth pages were taller than a 390x844 phone screen. Both pages render
// <main class="min-h-screen ... py-10">, so the card carried a 100vh floor (taller than a phone's visible area) plus
// 40px of padding top and bottom. The layouts own the fix: they give that <main> the visible height (dvh) with no
// vertical padding or margin of their own, so the page's own items-center centres the card inside the viewport.
const layouts = ['sign-in', 'sign-up'].map((name) => ({
  name,
  src: readFileSync(new URL(`../app/${name}/layout.tsx`, import.meta.url), 'utf8'),
}))

// The element each layout renders around {children}. Later work may put siblings beside the page inside this element
// (the site footer, #1781), so only the opening tag and {children} are matched.
function wrapperTokens(src: string): string[] {
  const m = /<div className="([^"]*)">\s*\{children\}/.exec(src)
  assert.ok(m, 'the layout wraps {children} in a single <div>')
  return m![1].split(/\s+/).filter(Boolean)
}

const VERTICAL_SPACING = /^(?:-)?(?:m[xy]?|p[xy]?|m[tb]|p[tb]|space-y)-/

for (const { name, src } of layouts) {
  test(`#1782 /${name} fits the viewport: visible height, no vertical padding or margin around the card`, () => {
    const tokens = wrapperTokens(src)
    assert.ok(tokens.includes('min-h-[100dvh]'), 'the wrapper is the visible height (dvh, not 100vh which is taller than a phone\'s visible area)')
    assert.ok(!tokens.includes('min-h-screen') && !tokens.includes('h-screen'), 'no 100vh floor on the wrapper')
    assert.ok(!tokens.includes('overflow-hidden'), 'the card is fitted, not clipped')
    const spacing = tokens.filter((t) => VERTICAL_SPACING.test(t) && !t.startsWith('[&>main]'))
    assert.deepEqual(spacing, [], 'no vertical padding or margin of its own: the card is the only height')
  })

  test(`#1782 /${name} hands that height to the page's <main> and keeps the card centred`, () => {
    const tokens = wrapperTokens(src)
    assert.ok(tokens.includes('flex') && tokens.includes('flex-col'), 'a column wrapper so the <main> can take its height')
    assert.ok(tokens.includes('[&>main]:flex-1'), '<main> fills the visible height')
    assert.ok(tokens.includes('[&>main]:min-h-0'), 'the page\'s min-h-screen floor is dropped')
    assert.ok(tokens.includes('[&>main]:py-0'), 'the page\'s 40px top/bottom padding is dropped')
  })
}

test('#1782 the pages keep their own centring and the fix stays in the layouts', () => {
  // sign-in/page.tsx renders SignInForm from sign-up-form.tsx (#1736), so the <main> lives in the form for both pages,
  // and the form renders one per state. Check every <main> those files render rather than one exact class string.
  const sources = ['../app/sign-in/page.tsx', '../app/sign-up/sign-up-form.tsx'].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8'))
  const mains = sources.flatMap((src) => [...src.matchAll(/<main\b[^>]*>/g)].map((m) => m[0]))
  assert.ok(mains.length > 0, 'the auth pages render a <main>')
  for (const tag of mains) {
    for (const cls of ['min-h-screen', 'flex', 'items-center', 'justify-center']) {
      assert.match(tag, new RegExp(`\\b${cls}\\b`), `the <main> keeps ${cls}: the layout removes its floor and padding, and it centres the card`)
    }
  }
})
