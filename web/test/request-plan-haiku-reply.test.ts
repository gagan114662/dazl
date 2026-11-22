import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePlan, groundedIn } from '../lib/scan/request-plan.ts'

// REAL: claude-haiku-4-5's raw reply on prod 87505c47 for "Dental clinics in London, Ontario hiring front desk staff in the last 90 days"
// (main: parsePlan null, reason 'schema'; industry_code came back as the number 621210). PM ruling 2026-11-22: a 2-6 digit integer code is
// read as its digit string; one JSON object inside a fence or prose is extracted; every other field stays strict; no legacy fallback.
const REQUEST = 'Dental clinics in London, Ontario hiring front desk staff in the last 90 days'
const REPLY = "```json\n{\n  \"offer\": null,\n  \"buyer_type\": \"Dental clinics\",\n  \"industry_code\": 621210,\n  \"places\": [\n    {\n      \"text\": \"London, Ontario\",\n      \"city\": \"London\",\n      \"region\": \"Ontario\",\n      \"country\": \"CA\"\n    }\n  ],\n  \"signals\": [\n    {\n      \"kind\": \"hiring\",\n      \"text\": \"hiring front desk staff in the last 90 days\",\n      \"negated\": false\n    }\n  ],\n  \"exclusions\": [],\n  \"language\": \"en\"\n}\n```"
test('PM ruling: the real Haiku reply (numeric industry_code, fenced) gives the London, Ontario plan', () => {
  const p = parsePlan(REPLY)
  assert.ok(p, 'parsed')
  assert.equal(p.industry_code, '621210')
  assert.deepEqual(p.places, [{ text: 'London, Ontario', city: 'London', region: 'Ontario', country: 'CA' }])
  assert.ok(groundedIn(REQUEST, p.places[0]))
})
test('PM ruling: the same object inside prose is extracted; other wrong types stay refused', () => {
  const body = REPLY.replace(/^```json\n|\n```$/g, '')
  assert.ok(parsePlan(`Here is the plan:\n${body}\nHope this helps.`))
  for (const bad of [body.replace('621210', '6212100'), body.replace('621210', '62.5'), body.replace('621210', '-621210'), body.replace('"negated": false', '"negated": 0')])
    assert.equal(parsePlan(bad), null, bad.slice(0, 80))
  assert.equal(parsePlan(`${body}\n${body}`), null, 'two objects are not one')
})
