// #673 follow-up: the root layout's "Skip to content" link (href="#main") must move keyboard focus to <main id="main">
// on the public pages too (/, sign-in, sign-up incl. its check-email state, reset, verify, privacy, terms). Fragment
// navigation only moves focus to a focusable target, so every public <main id="main"> needs tabIndex={-1}; without it
// Chromium leaves focus on BODY on a page too short to count as a focusable scroller. The /app routes share one
// <main> in app/app/layout.tsx, covered by test/skip-link-focus-target.test.ts.
// Source invariant (no build or browser here); live focus is checked by test/ui/public-skip-link-focus.ui.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const web = path.join(import.meta.dirname, '..')
const appDir = path.join(web, 'app')

// Every <main ...> opening tag outside app/app whose attributes include id="main".
function publicMainTags(): { file: string, tag: string }[] {
  const out: { file: string, tag: string }[] = []
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f)
      if (statSync(p).isDirectory()) { if (p !== path.join(appDir, 'app') && p !== path.join(appDir, 'api')) walk(p) }
      else if (/\.(tsx|jsx)$/.test(f)) {
        for (const m of readFileSync(p, 'utf8').matchAll(/<main\b[^>]*>/g)) if (/\bid="main"/.test(m[0])) out.push({ file: path.relative(web, p), tag: m[0] })
      }
    }
  }
  walk(appDir)
  return out
}

test('the public pages render a skip-link target', () => {
  const files = new Set(publicMainTags().map(t => t.file))
  for (const f of ['app/page.tsx', 'app/sign-in/page.tsx', 'app/sign-up/sign-up-form.tsx', 'app/reset/reset-form.tsx', 'app/verify/page.tsx', 'app/privacy/page.tsx', 'app/terms/page.tsx']) {
    assert.ok(files.has(f), `${f} has no <main id="main">`)
  }
})

test('every public <main id="main"> is a programmatic focus target (tabIndex={-1})', () => {
  const bad = publicMainTags().filter(t => !/\btabIndex=\{-1\}/.test(t.tag)).map(t => `${t.file}: ${t.tag}`)
  assert.deepEqual(bad, [])
})
