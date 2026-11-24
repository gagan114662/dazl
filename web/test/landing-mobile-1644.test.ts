// #1644: at phone width the homepage demo's leads were shown at a quarter strength for half of every loop, and its small
// labels used the lightest text colour. Source checks only; the page is checked in the browser on staging.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('#1644: below 640px the demo results are never faded', () => {
  const css = read('app/globals.css')
  assert.match(css, /\.lp-fade \{ opacity: \.25;/, 'the step-by-step reveal stays on wider screens')
  const at = css.indexOf('.lp-fade.lp-in { opacity: 1; transform: none; }')
  const phone = /@media \(max-width: 639px\) \{ \.lp-fade \{ opacity: 1; transform: none; \} \}/.exec(css)
  assert.ok(phone, 'phone-width rule present')
  assert.ok(phone.index > at && at > css.indexOf('.lp-fade { opacity: .25;'), 'it comes after the base rule, so it wins')
})

test('#1644: the demo labels use the secondary text colour, and the example label is not the smallest size', () => {
  const demo = read('app/landing-demo.tsx')
  assert.match(demo, /className="text-sm font-medium text-\[var\(--ink-2\)\][^"]*" data-testid="demo-label"/)
  assert.match(demo, /text-\[var\(--ink-2\)\]">2 more set aside for you to check</)
  assert.match(demo, /text-\[var\(--ink-2\)\]">\{l\.date\}</)
})
