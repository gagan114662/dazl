import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// #916: an unknown-budget batch is refused on resume (fail closed). The Leads page must show the route's human
// re-import explanation, never the raw machine code, and must not re-import or queue anything on its own.
const src = readFileSync(fileURLToPath(new URL('../app/app/leads/leads-client.tsx', import.meta.url)), 'utf8')
const start = src.indexOf('async function resumeCsv()')
const body = src.slice(start, src.indexOf('\n  }\n', start))

test('resumeCsv shows the re-import message for batch_budget_unknown, not the raw code', () => {
  assert.ok(start > 0, 'resumeCsv not found')
  assert.match(body, /j\.error === 'batch_budget_unknown' \? \(j\.message \|\|/)
  assert.match(body, /Re-import the file/)
})

test('resumeCsv does not re-import or queue anything after a refusal', () => {
  const refusal = body.slice(body.indexOf('if (!r.ok)'))
  const afterRefusal = refusal.slice(0, refusal.indexOf('return }'))
  assert.doesNotMatch(afterRefusal, /fetch\(|importCsv|queue/i)
})

test('migrateCsv comment no longer describes the deleted BATCH_UNKNOWN_BUDGET fallback', () => {
  const csv = readFileSync(fileURLToPath(new URL('../lib/scan/csv-import.ts', import.meta.url)), 'utf8')
  assert.doesNotMatch(csv, /BATCH_UNKNOWN_BUDGET/)
  assert.match(csv, /resume refuses it \(batch_budget_unknown, fail closed\)/)
})
