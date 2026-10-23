import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Route wiring regression: sequence creation already supplies editable templates.
// A click without explicit AI intent must never invoke the optional paid rewrite.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
test('sequence create route is template-only, with no AI draft call or import', () => {
  const route = read('app/api/outreach/sequences/route.ts')
  assert.doesNotMatch(route, /draftSequenceSteps|llmStepText|providers|provider\.complete/)
  const create = route.slice(route.indexOf("if (b?.action === 'create'"), route.indexOf("if (b?.action === 'create_test_fixture'"))
  assert.match(create, /createSequence\(db,user.id,b.message_id/)
  assert.match(create, /return NextResponse.json\(\{ id \}\)/)
  assert.doesNotMatch(create, /await /)
})
test('sequence create button clearly says templates, not a paid AI rewrite', () => {
  const client = read('app/app/outreach/outreach-client.tsx')
  assert.match(client, />Create 3-step sequence \(templates\)<\/button>/)
  assert.match(client, /without an AI call or provider charge/)
})
