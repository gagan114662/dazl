import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #1700: on a phone (390px) the signed-in app showed two vertical scrollbars, the page's and <main>'s. The shell must be the
// only thing that sizes the page (visible height, clipped), with <main> as the single scroller. Class-level pin: the rendered
// check at 390px is the issue's live check.
const layout = readFileSync(new URL('../app/app/layout.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
const shell = /<div className="(app-ui [^"]*)"/.exec(layout)?.[1].split(' ') ?? []

test('#1700 the app shell is the visible height and clips, so only <main> scrolls', () => {
  assert.ok(shell.includes('h-dvh'), 'visible height, not 100vh (taller than a phone\'s visible area)')
  assert.ok(!shell.includes('h-screen'))
  assert.ok(shell.includes('relative') && shell.includes('overflow-hidden'), 'absolutely positioned descendants cannot stretch the page')
  assert.match(layout, /<main id="main"[^>]*className="flex-1 min-w-0 overflow-auto( max-md:peer-checked:hidden)?"/, '<main> stays the one scroller')
})
test('#1700 the 100vh floor on html/body does not apply to the app shell', () => {
  assert.match(css, /html:has\(\.app-shell\), body:has\(\.app-shell\) \{ min-height: 0; \}/)
  assert.doesNotMatch(css, /html:has\(\.app-ui\)/, '.app-ui is also on the public landing page and first-run overlay; only the signed-in shell may drop the floor')
  assert.ok(shell.includes('app-shell'), 'the signed-in shell carries the class the selector keys on')
  const landing = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(landing, /\bapp-shell\b/, 'the public landing page keeps its 100vh floor')
  assert.match(css, /html, body \{[^}]*min-height: 100vh;/, 'public pages keep their floor')
})
test('#1771 a staging banner above the shell does not add page scroll: body is the visible-height column, the shell fills the rest', () => {
  assert.match(css, /body:has\(> \.app-shell\) \{[^}]*display: flex; flex-direction: column; height: 100dvh; overflow: hidden;/)
  assert.match(css, /body:has\(> \.app-shell\) > \.app-shell \{ height: auto; flex: 1 1 0; min-height: 0; \}/)
  assert.match(css, /\[data-testid="staging-banner"\] \{ flex: none; \}/)
})
