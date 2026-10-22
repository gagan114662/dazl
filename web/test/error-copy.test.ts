import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { KEY_UNREADABLE_COPY, knownErrorCopy } from '../lib/error-copy.ts'

test('knownErrorCopy: key_unreadable maps to the friendly message, never the raw code', () => {
  const copy = knownErrorCopy('key_unreadable')
  assert.equal(copy, KEY_UNREADABLE_COPY)
  assert.match(copy!, /Re-enter it in Settings\./)
  assert.ok(!copy!.includes('key_unreadable'))
})

test('knownErrorCopy: shared codes map, context-specific and unknown codes return null', () => {
  assert.match(knownErrorCopy('key_rejected')!, /rejected/)
  assert.match(knownErrorCopy('trial_key_invalid')!, /try again later/i)
  assert.equal(knownErrorCopy('no_api_key'), null) // callers phrase this per surface
  assert.equal(knownErrorCopy('some_future_code'), null)
  assert.equal(knownErrorCopy(undefined), null)
  assert.equal(knownErrorCopy(42), null)
})

test('leads page: preview and run route API errors through knownErrorCopy exactly once each', () => {
  const src = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  const branches = src.match(/if \(!r\.ok\) \{ setError\(/g) ?? []
  assert.equal(branches.length, 2, 'preview() and run() each get one error branch - a second is dead code')
  const routed = src.match(/if \(!r\.ok\) \{ setError\(knownErrorCopy\(j\.error\)/g) ?? []
  assert.equal(routed.length, 2, 'both branches consult knownErrorCopy before raw/fallback text')
})

test('leads page: job-failed render never shows the raw code either', () => {
  const src = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  assert.ok(src.includes("jobError === 'key_unreadable' ? KEY_UNREADABLE_COPY"), 'job failure reuses the shared copy')
})
