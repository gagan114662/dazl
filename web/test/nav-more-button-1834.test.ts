// #1834: the phone menu's 'More' toggle was a <details> summary, which screen readers do not expose as a button.
// The toggle must carry button semantics with an aria-expanded that reflects the actual open state, without
// changing the look. Source-structure test (the live a11y-tree check is the post-deploy acceptance).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../app/app/nav.tsx', import.meta.url), 'utf8')

test('#1834 the More toggle is a button with a live aria-expanded', () => {
  const summary = src.match(/<summary[\s\S]*?More[\s\S]*?<\/summary>/)?.[0] ?? ''
  assert.ok(summary, 'the More summary exists')
  assert.match(summary, /role="button"/, 'the toggle is exposed as a button')
  assert.match(summary, /aria-expanded=\{moreOpen\}/, 'aria-expanded reflects the open state')
  assert.match(summary, /onClick=/, 'clicking toggles the state (so aria-expanded stays true)')
  assert.match(src, /<details[^>]*open=\{moreOpen\}/, 'the details open state is the same state')
  assert.match(src, /useState\(moreOn\)/, 'the state starts from the route match, as the details did')
  assert.match(src, /if \(where !== prevWhere\) \{ setPrevWhere\(where\); setMoreOpen\(moreOn\) \}/, 'every navigation resets the open state to the route match: a More page opens it, leaving one closes it')
})
