import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Regression lock for the hidden-paid-rewrite incident: creating a draft must stay
// reliably free. The LLM polish bills the tenant's provider key, so it may only run
// from the explicit polish endpoint - never from the create route or its imports.
test('POST /api/outreach (draft create) cannot reach the paid polish path', () => {
  const route = readFileSync(new URL('../app/api/outreach/route.ts', import.meta.url), 'utf8')
  assert.ok(!route.includes('draft-llm'), 'create route must not import the LLM polish module')
  assert.ok(!route.includes('polishDraft'), 'create route must not call polishDraft')
})

test('the explicit polish endpoint is a separate route that owns the paid call', () => {
  const polish = readFileSync(new URL('../app/api/outreach/polish/route.ts', import.meta.url), 'utf8')
  assert.match(polish, /polishDraft/)
  assert.match(polish, /rateLimit/)
  assert.match(polish, /sameOriginJson/)
})
