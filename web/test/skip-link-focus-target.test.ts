// #673: the root layout's "Skip to content" link (href="#main") must move keyboard focus to the /app layout's
// <main id="main"> on every /app route (Home, Inbox, Settings, ...). Fragment navigation only moves focus to a
// focusable target, so that <main> needs tabIndex={-1}. Without it Chromium focused <main> only when the pane was
// tall enough to count as a focusable scroller (Settings), and left focus on BODY on Home and Inbox.
// Source invariant (no build or browser here); the live behaviour is checked by test/ui/frontend-baseline.ui.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const web = path.join(import.meta.dirname, '..')
const read = (rel: string) => readFileSync(path.join(web, rel), 'utf8')

// The opening tag of the first <main ...> whose attributes include id="main".
function mainTag(src: string): string | null {
  for (const m of src.matchAll(/<main\b[^>]*>/g)) if (/\bid="main"/.test(m[0])) return m[0]
  return null
}

test('root layout skip link targets #main', () => {
  assert.match(read('app/layout.tsx'), /<a href="#main" className="skip-link">/)
})

test('/app layout <main id="main"> is a programmatic focus target (tabIndex={-1})', () => {
  const tag = mainTag(read('app/app/layout.tsx'))
  assert.ok(tag, 'app/app/layout.tsx has no <main id="main">')
  assert.match(tag!, /\btabIndex=\{-1\}/, `skip-link target is not focusable: ${tag}`)
})

test('no /app page or component renders a second id="main" that would shadow the layout target', () => {
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
