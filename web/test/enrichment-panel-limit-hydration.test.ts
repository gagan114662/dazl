// #594 review: the credit-limit inputs must show the saved tenant limit after a reload; a blank field whose Save sends null
// would silently clear a limit the user never touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../app/app/settings/enrichment-panel.tsx', import.meta.url), 'utf8')

test('limit inputs hydrate from the saved tenant limit and an unchanged Save is not offered', () => {
  assert.match(src, /value=\{limits\[u\.provider \+ u\.window\] \?\? \(u\.source === 'tenant' && u\.limit !== null \? String\(u\.limit\) : ''\)\}/)
  assert.match(src, /saved = u\.source === 'tenant' && u\.limit !== null \? String\(u\.limit\) : ''/)
  assert.match(src, /const v = \(limits\[key\] \?\? saved\)\.trim\(\)/)
  assert.doesNotMatch(src, /value=\{limits\[u\.provider \+ u\.window\] \?\? ''\}/, 'no blank-initial value')
})

test('blank + Save never clears: Save needs a changed whole number, removal is the separate Clear control', () => {
  assert.match(src, /const canSave = \/\^\[0-9\]\+\$\/\.test\(v\) && v !== saved/)
  assert.match(src, /disabled=\{!canSave\}/)
  assert.match(src, /aria-label=\{`Clear \$\{u\.provider\} \$\{u\.window\} credit limit`\}/)
  assert.doesNotMatch(src, /limit: v === '' \? null/, 'Save no longer maps blank to null')
})
