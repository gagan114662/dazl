// #674: the phone menu must close when the user navigates, and the Settings email field must have its own full-width row on a phone.
// Found on a real phone (Gagan's screenshots of /app/inbox and /app/settings, 2026-11-10): the menu stayed open from the previous page and pushed the content below
// the fold, and the "New email address" placeholder was cut to "New email addre". The layout survives client navigation, so the checkbox keeps its state.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { NAV_TOGGLE_ID, closeMobileMenu } from '../app/app/nav-toggle.ts'

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

test('closeMobileMenu unchecks an open menu, leaves a closed one alone and never throws without it', () => {
  const box = { checked: true }, doc = { getElementById: (id: string) => id === NAV_TOGGLE_ID ? box : null }
  closeMobileMenu(doc); assert.equal(box.checked, false)
  closeMobileMenu(doc); assert.equal(box.checked, false)
  assert.doesNotThrow(() => closeMobileMenu({ getElementById: () => null }))
})

test('the layout checkbox, its label and the CSS focus ring all use the id the nav closes', () => {
  const layout = src('app/app/layout.tsx'), css = src('app/globals.css')
  assert.match(layout, /id=\{NAV_TOGGLE_ID\} type="checkbox"/); assert.match(layout, /htmlFor=\{NAV_TOGGLE_ID\}/)
  assert.equal(NAV_TOGGLE_ID, 'navtoggle'); assert.ok(css.includes(`#${NAV_TOGGLE_ID}:focus-visible`))
})

test('the nav closes the menu on every navigation (path or query change) and on every link tap', () => {
  const nav = src('app/app/nav.tsx')
  assert.match(nav, /useEffect\(\(\) => \{ closeMobileMenu\(document\) \}, \[where\]\)/)
  assert.match(nav, /const where = `\$\{p\}\?\$\{q\.toString\(\)\}`/)
  assert.match(nav, /<Link href=\{item\.href\}[^>]*onClick=\{\(\) => closeMobileMenu\(document\)\}/)
})

test('Settings: the email field takes its own row on a phone and the button is full width; from sm up the row is unchanged', () => {
  const panel = src('app/app/settings/account-panel.tsx')
  const input = panel.match(/<input className="([^"]*)" type="email" placeholder="New email address"/)?.[1] ?? ''
  assert.ok(input.split(' ').includes('max-sm:basis-full'), `phone row: ${input}`)
  assert.ok(input.split(' ').includes('sm:flex-1') && input.split(' ').includes('sm:min-w-[12rem]'), `sm up: ${input}`)
  assert.ok(!input.split(' ').includes('min-w-[12rem]') && !input.split(' ').includes('flex-1'), 'the old phone-width rule (shared row, clipped placeholder) is gone')
  assert.match(panel, /<button className="btn-primary max-sm:w-full" disabled=\{!next\.trim\(\)\}/)
})

test('an open phone menu never takes more than about half the screen, so the page content stays visible under it', () => {
  const layout = src('app/app/layout.tsx'), aside = layout.match(/<aside className="([^"]*)"/)?.[1] ?? ''
  assert.ok(aside.split(' ').includes('max-md:max-h-[55svh]') && aside.split(' ').includes('max-md:overflow-auto'), aside)
  assert.ok(aside.includes('md:w-60') && aside.includes('md:overflow-auto'), 'the desktop sidebar is unchanged')
})
