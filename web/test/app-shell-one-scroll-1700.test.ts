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
  assert.match(layout, /<main id="main"[^>]*className="flex-1 min-w-0 overflow-auto"/, '<main> stays the one scroller')
})
test('#1700 the 100vh floor on html/body does not apply to the app shell', () => {
  assert.match(css, /html:has\(\.app-ui\), body:has\(\.app-ui\) \{ min-height: 0; \}/)
  assert.match(css, /html, body \{[^}]*min-height: 100vh;/, 'public pages keep their floor')
})
