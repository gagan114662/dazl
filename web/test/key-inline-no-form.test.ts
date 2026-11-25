import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const raw = readFileSync(new URL('../app/app/key-inline.tsx', import.meta.url), 'utf8')
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '') // the rationale comment itself names the bug

test('KeyInline renders no form and can never be captured by an ancestor form', () => {
  assert.equal(/<form[\s>]/.test(src), false, 'no <form> element (nested forms are dropped by the parser)')
  assert.equal(/method=/.test(src), false, 'no native form method')
  assert.doesNotMatch(src, /<(?:button|input|textarea|select)\b/, 'no control can submit an ancestor form')
  assert.doesNotMatch(src, /on(?:KeyDown|Submit|Click)\s*=/, 'neither Enter nor a click can save a key')
  assert.doesNotMatch(src, /fetch\s*\(|XMLHttpRequest|sendBeacon|settings\/llm-key/, 'no credential request')
  assert.doesNotMatch(src, /htmlFor="ai-key"/, 'no obsolete label points at a key field')
  assert.match(src, /return null/, 'the retired component renders no status or other UI')
})
