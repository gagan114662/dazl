// MISSION v2 part E: the city permits source (lib/research/sources/socrata-permits.ts), on REAL recorded rows of the Austin dataset
// (test/fixtures/research-austin-permits.json, fetched 15 Nov 2026). No network: the HTTP getter is a stub serving the recording.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AUSTIN_PERMITS, permitMatches, permitQuery, permitSignals, socrataPermitsSource } from '../lib/research/sources/socrata-permits.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const FX = JSON.parse(readFileSync(new URL('./fixtures/research-austin-permits.json', import.meta.url), 'utf8')) as { rows: Record<string, unknown>[] }
const SINCE = '2026-08-17'
const ROOF = AUSTIN_PERMITS.categories.roofing
const AUSTIN = { city: 'Austin', region: 'TX', country: 'US', category: 'roofing' }

test('the category rule on real rows: roofing contractors in, the solar installer and the electrician / plumber on a remodel "with a roof" out', () => {
  const by = (name: string) => FX.rows.filter(r => String(r.contractor_company_name).startsWith(name))
  assert.ok(by('Freedom Solar Power').length > 0 && by('Freedom Solar Power').every(r => !permitMatches(AUSTIN_PERMITS, ROOF, r)), 'rooftop solar is not roofing')
  for (const n of ['Beckett Electrical Services', 'We Plumb LLC', 'Thermal Energy Heating']) assert.ok(by(n).every(r => !permitMatches(AUSTIN_PERMITS, ROOF, r)), `${n}: a trade sub on a remodel is not a roofer`)
  for (const n of ['Kanga Roof LLC', 'QUICK ROOFING LLC', 'Precision Reconstruction Group', 'LOA Construction', 'Kentex Roofing Systems']) assert.ok(by(n).some(r => permitMatches(AUSTIN_PERMITS, ROOF, r)), `${n} is a roofing contractor`)
})

test('one record per company, dated by the permit itself, citing its public record, naming the contractor of record (never relabelled as hiring)', () => {
  const s = permitSignals(AUSTIN_PERMITS, 'roofing', FX.rows, SINCE)
  const names = s.map(x => x.company)
  assert.ok(!names.some(n => /solar|electric|plumb|thermal/i.test(n)), JSON.stringify(names))
  assert.equal(new Set(names).size, names.length, 'one record per company')
  const kanga = s.find(x => x.company === 'Kanga Roof LLC')!
  assert.equal(kanga.eventKind, 'roofing_permits')
  assert.match(kanga.eventDate, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(kanga.eventCount, FX.rows.filter(r => String(r.contractor_company_name).startsWith('Kanga Roof LLC')).length)
  assert.match(kanga.sourceUrl, /^https:\/\/abc\.austintexas\.gov\//)
  assert.equal(kanga.personName, 'Stacie Feller'); assert.equal(kanga.personTitle, 'Contractor of record on the Austin permit')
  assert.match(kanga.eventSummary, /roofing permits? issued in Austin since 2026-08-17/)
  assert.doesNotMatch(kanga.eventSummary, /hiring/i)
  assert.ok(s.some(x => x.company === 'Empire Roofing Companies LLC'), 'the dataset marker "**MAIN**" is stripped from the name')
  // a window starting after every row: nothing
  assert.deepEqual(permitSignals(AUSTIN_PERMITS, 'roofing', FX.rows, '2027-01-01'), [])
})

test('the source: covers only its city and category, builds a bounded server query, and reports a failed read instead of an empty market', async () => {
  const src = socrataPermitsSource()
  assert.equal(src.covers(AUSTIN), true); assert.equal(src.covers({ ...AUSTIN, city: 'Dallas' }), false); assert.equal(src.covers({ ...AUSTIN, category: 'dental' }), false)
  const q = new URL(permitQuery(AUSTIN_PERMITS, ROOF, SINCE))
  assert.equal(q.origin + q.pathname, 'https://data.austintexas.gov/resource/3syk-w9eu.json')
  assert.match(q.searchParams.get('$where')!, /issue_date >= '2026-08-17T00:00:00' AND contractor_company_name IS NOT NULL AND upper\(description\) like '%ROOF%'/)
  assert.equal(q.searchParams.get('$limit'), '2000'); assert.match(q.searchParams.get('$select')!, /^issue_date,contractor_company_name,contractor_full_name,/)
  const serve = (status: number, body: string, truncated = false): SafeGet => async () => ({ status, body, truncated })
  const ok = await src.collect(AUSTIN, SINCE, serve(200, JSON.stringify(FX.rows)))
  assert.ok(ok.signals.length >= 6 && ok.notes.length === 0, JSON.stringify(ok.notes))
  assert.deepEqual((await src.collect(AUSTIN, SINCE, serve(429, ''))).notes, ['throttled'])
  assert.deepEqual((await src.collect(AUSTIN, SINCE, serve(200, '<!doctype html><html>blocked</html>'))).notes, ['not_json'])
  assert.deepEqual((await src.collect(AUSTIN, SINCE, serve(200, '[{', true))).notes, ['oversize'])
  assert.deepEqual((await src.collect(AUSTIN, SINCE, async () => null)).notes, ['unreachable'])
  assert.deepEqual((await src.collect({ ...AUSTIN, city: 'Dallas' }, SINCE, serve(200, '[]'))).notes, ['not_covered'])
})
