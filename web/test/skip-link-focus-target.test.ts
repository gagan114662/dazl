// #673: the root layout's "Skip to content" link (href="#main") must move keyboard focus to the /app layout's
// <main id="main"> on every /app route (Home, Inbox, Settings, ...), and keep it there. Fragment navigation only moves
// focus to a focusable target, so that <main> needs tabIndex={-1}. Without it Chromium focused <main> only when the
// pane was tall enough to count as a focusable scroller (Settings), and left focus on BODY on Home and Inbox.
// Source invariants plus the focus-keeping rule (no build or browser here); the live keyboard check, in loaded and
// loading states, is test/ui/frontend-baseline.ui.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { shouldRestoreMainFocus } from '../lib/main-focus.ts'

const web = path.join(import.meta.dirname, '..')
const read = (rel: string) => readFileSync(path.join(web, rel), 'utf8')

// The opening tag of the first <main ...> whose attributes include id="main".
function mainTag(src: string): string | null {
  for (const m of src.matchAll(/<main\b[^>]*>/g)) if (/\bid="main"/.test(m[0])) return m[0]
  return null
}

test('#673 root layout skip link targets #main', () => {
  assert.match(read('app/layout.tsx'), /<a href="#main" className="skip-link">/)
})

test('#673 /app layout <main id="main"> is a programmatic focus target (tabIndex={-1}) with a visible focus ring', () => {
  const tag = mainTag(read('app/app/layout.tsx'))
  assert.ok(tag, 'app/app/layout.tsx has no <main id="main">')
  assert.match(tag!, /\btabIndex=\{-1\}/, `skip-link target is not focusable: ${tag}`)
  assert.doesNotMatch(tag!, /\boutline-none\b/, `focus on <main> would be invisible: ${tag}`)
  assert.match(read('app/globals.css'), /#main:focus-visible\s*\{[^}]*outline:\s*3px solid/)
})

test('#673 /app layout mounts MainFocus so focus survives loading/hydration swaps', () => {
  const src = read('app/app/layout.tsx')
  assert.match(src, /import MainFocus from '\.\/main-focus'/)
  assert.match(src, /<MainFocus \/>/)
})

test('#673 Home onboarding does not autofocus on load (the first Tab must reach the skip link)', () => {
  const src = read('app/app/first-run.tsx')
  const input = src.split('\n').find(l => l.includes('<input') && l.includes('aria-label="Your website"'))
  assert.ok(input, 'first-run.tsx has no "Your website" input')
  assert.doesNotMatch(input!, /\bautoFocus\b/)
})

test('#673 no /app page or component renders a second id="main" that would shadow the layout target', () => {
  const dir = path.join(web, 'app/app')
  const hits: string[] = []
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(tsx|ts|jsx|js)$/.test(f) && p !== path.join(dir, 'layout.tsx') && /\bid="main"/.test(readFileSync(p, 'utf8'))) hits.push(path.relative(web, p))
    }
  }
  walk(dir)
  assert.deepEqual(hits, [])
})

test('#673 focus goes back to <main> only when the focused node in <main> was removed', () => {
  const body = { tag: 'BODY' }
  const removed = { isConnected: false }, present = { isConnected: true }
  assert.equal(shouldRestoreMainFocus(body, body, removed, false), true, 'loading view swapped out under focus')
  assert.equal(shouldRestoreMainFocus(null, body, removed, false), true, 'no active element at all')
  assert.equal(shouldRestoreMainFocus(body, body, present, false), false, 'deliberate blur / Tab out: node still there')
  assert.equal(shouldRestoreMainFocus(body, body, removed, true), false, 'a pointer press since: respect the click')
  assert.equal(shouldRestoreMainFocus(body, body, null, false), false, 'focus was never in <main>')
  assert.equal(shouldRestoreMainFocus({ tag: 'BUTTON' }, body, removed, false), false, 'focus already moved elsewhere')
})
