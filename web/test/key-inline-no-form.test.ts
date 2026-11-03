// KeyInline must never render a <form> (#409). It is placed inside other forms (first-run brain and ask steps);
// the HTML parser drops a nested <form>, the controls join the outer form, and 'Save key' submits THAT natively -
// no llm-key PUT, page state lost (confirmed live on 40e7bf30). The component is a div with an explicit
// type="button" and an Enter handler, so no placement can reintroduce the capture. This guard keeps it that way.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const raw = readFileSync(new URL('../app/app/key-inline.tsx', import.meta.url), 'utf8')
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '') // the rationale comment itself names the bug

test('KeyInline renders no form and can never be captured by an ancestor form', () => {
  assert.equal(/<form[\s>]/.test(src), false, 'no <form> element (nested forms are dropped by the parser)')
  assert.equal(/method=/.test(src), false, 'no native form method')
  assert.ok(src.includes('type="button"'), 'the save button is type="button" - it cannot submit an ancestor form')
  assert.ok(/onKeyDown=\{e => \{ if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\)/.test(src), 'Enter saves with preventDefault, never the ancestor form')
  assert.ok(src.includes("fetch('/api/settings/llm-key', { method: 'PUT'"), 'the save path is still the real llm-key PUT')
  assert.ok(src.includes('htmlFor="ai-key"'), 'label association kept')
  assert.ok(src.includes('role="status"'), 'status region kept')
})
