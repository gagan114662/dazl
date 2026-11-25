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

test('an open phone menu is the whole page body with ONE scroll, and the page behind it is hidden (#1771)', () => {
  // #1771 (prod c31d6f9c, 390px): the menu opened as a capped band (max-h-55svh) with its own scroll above a second page scroll, so
  // Settings and Sign out sat below the fold. Now the open menu takes all the height under the header, scrolls once inside itself,
  // and <main> is not shown (so there is no second scroller and nothing behind it to scroll). Desktop sidebar unchanged.
  const layout = src('app/app/layout.tsx'), aside = layout.match(/<aside className="([^"]*)"/)?.[1] ?? '', main = layout.match(/<main id="main"[^>]*className="([^"]*)"/)?.[1] ?? ''
  const a = aside.split(' ')
  assert.ok(!a.some(c => /^max-md:max-h-/.test(c)), `no height cap on the open menu: ${aside}`)
  assert.ok(a.includes('max-md:flex-1') && a.includes('max-md:min-h-0') && a.includes('max-md:overflow-y-auto'), `the open menu fills the body and is the one scroller: ${aside}`)
  assert.ok(a.includes('hidden') && a.includes('peer-checked:flex') && a.includes('md:flex'), `closed it is hidden, open it shows, from md up it is always shown: ${aside}`)
  assert.ok(aside.includes('md:w-60') && aside.includes('md:overflow-auto'), 'the desktop sidebar is unchanged')
  assert.ok(main.split(' ').includes('max-md:peer-checked:hidden'), `<main> is hidden while the phone menu is open, so the page behind cannot scroll: ${main}`)
  assert.ok(main.split(' ').includes('overflow-auto') && main.split(' ').includes('flex-1'), 'closed, <main> is still the one scroller')
  // The Menu label stays in the header above the aside (never inside <main>), so the menu can always be closed.
  assert.ok(layout.indexOf('htmlFor={NAV_TOGGLE_ID}') < layout.indexOf('<aside'), 'the Menu label comes before the menu')
  // Settings (the nav) and Sign out live inside the one scrolling menu.
  const asideBody = layout.slice(layout.indexOf('<aside'), layout.indexOf('</aside>'))
  assert.match(asideBody, /<Nav \/>/); assert.match(asideBody, /api\/auth\/signout/)
})

test('Inbox: the explanatory note under the reply-rate heading is readable size (text-sm) on a phone and keeps its small size from sm up', () => {
  const panel = src('app/app/inbox/conversion-panel.tsx'), cls = panel.match(/<p className="([^"]*)">Sent emails only\./)?.[1] ?? ''
  assert.ok(cls.split(' ').includes('text-sm') && cls.split(' ').includes('sm:text-xs'), cls)
})

test('#1771 review: with the menu open <main> is hidden, so the layout closes the menu when the skip link is used', () => {
  const layout = src('app/app/layout.tsx')
  assert.match(layout, /a\.skip-link/, 'the layout handles clicks on the root skip link')
  assert.match(layout, /\.checked=false/, 'and unchecks the menu toggle before the jump')
  assert.ok(layout.indexOf("a.skip-link") < layout.indexOf('<main id="main"'), 'the handler is in place before <main>')
})
