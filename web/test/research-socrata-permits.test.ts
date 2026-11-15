// MISSION v2 part E: the city permits source (lib/research/sources/socrata-permits.ts), on REAL recorded rows of the Austin dataset
// (test/fixtures/research-austin-permits.json, fetched 15 Nov 2026). No network: the HTTP getter is a stub serving the recording.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AUSTIN_PERMITS, austinPermitsSource, permitMatches, permitQuery, permitSignals } from '../lib/research/sources/socrata-permits.ts'
import { huntWithRegistry } from '../lib/research/hunt.ts'
import type { ResearchCase } from '../lib/research/types.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const FX = JSON.parse(readFileSync(new URL('./fixtures/research-austin-permits.json', import.meta.url), 'utf8')) as { rows: Record<string, unknown>[] }
const SINCE = '2026-08-17'
const ROOF = AUSTIN_PERMITS.categories.roofing
const AUSTIN: ResearchCase = { tenant: 't', jobId: 'j', query: 'roofing contractors in Austin', offer: 'x', where: 'Austin, Texas', category: 'roofing contractors', windowDays: 90, today: '2026-11-15' }

test('the category rule on real rows: roofing contractors in, the solar installer and the electrician / plumber on a remodel "with a roof" out', () => {
  const kanga = FX.rows.find(r => String(r.contractor_company_name).startsWith('Kanga Roof LLC'))!
  assert.equal(permitMatches(AUSTIN_PERMITS, ROOF, { ...kanga, contractor_trade: null }), false, 'no trade on the row: not provably the general contractor')
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
  assert.match(kanga.pageUrl, /^https:\/\/abc\.austintexas\.gov\//)
  assert.match(kanga.recordUrl, /^https:\/\/data\.austintexas\.gov\/resource\/3syk-w9eu\.json\?permit_number=/, 'the readable record (the permit page is behind a captcha)')
  assert.equal(kanga.personName, 'Stacie Feller'); assert.equal(kanga.personTitle, 'Contractor of record on the Austin permit')
  assert.match(kanga.eventSummary, /roofing permits? issued in Austin since 2026-08-17/)
  assert.doesNotMatch(kanga.eventSummary, /hiring/i)
  assert.ok(s.some(x => x.company === 'Empire Roofing Companies LLC'), 'the dataset marker "**MAIN**" is stripped from the name')
  // a window starting after every row: nothing
  assert.deepEqual(permitSignals(AUSTIN_PERMITS, 'roofing', FX.rows, '2027-01-01'), [])
})

test("A's Candidate: via registry, dated by the record, the readable record URL, the record's facts in the snippet", async () => {
  const { candidates } = await austinPermitsSource.collect(AUSTIN, SINCE, async () => ({ status: 200, body: JSON.stringify(FX.rows) }))
  const k = candidates.find(x => x.title.startsWith('Kanga Roof LLC'))!
  assert.equal(k.via, 'registry'); assert.equal(k.dated, 'registry'); assert.equal(k.triggerId, 'registry:roofing_permits')
  assert.match(k.date!, /^2026-\d\d-\d\d$/); assert.ok(k.date! >= SINCE)
  assert.match(k.url, /^https:\/\/data\.austintexas\.gov\/resource\/3syk-w9eu\.json\?permit_number=/)
  assert.match(k.snippet, /^Kanga Roof LLC - \d+ roofing permits? issued in Austin since 2026-08-17; latest .* Contractor of record: Stacie Feller\. Public permit page: https:\/\/abc\.austintexas\.gov\//)
  // hunt merges them as `extra`, and the hook is exactly hunt() unless LEAD_ENGINE=research
  const serve: SafeGet = async () => ({ status: 200, body: JSON.stringify(FX.rows) })
  const plan = { persona: 'p', decisionMakerTitles: [], triggers: [], askingQueries: [], source: 'fallback' as const }
  const none = async () => ({ ok: true as const, hits: [] })
  const off = await huntWithRegistry(AUSTIN, plan, none, serve, { env: {} })
  assert.equal(off.candidates.length, 0); assert.deepEqual(off.registry, {})
  const on = await huntWithRegistry(AUSTIN, plan, none, serve, { env: { LEAD_ENGINE: 'research' } })
  assert.deepEqual(on.candidates, candidates); assert.equal(on.funnel.out, candidates.length)
  assert.equal((await huntWithRegistry({ ...AUSTIN, where: 'Dallas, Texas' }, plan, none, serve, { env: { LEAD_ENGINE: 'research' } })).candidates.length, 0)
  // a source that throws, and one that cannot read: the hunt goes on, and both show in the scan funnel (never an empty market)
  const boom = { id: 'boom', covers: () => true, collect: async () => { throw new Error('x') } }
  const down = await huntWithRegistry(AUSTIN, plan, none, async () => ({ status: 503, body: '' }), { env: { LEAD_ENGINE: 'research' }, sources: [boom, austinPermitsSource] })
  assert.equal(down.candidates.length, 0)
  assert.equal(down.funnel.dropped.registry_boom_error, 1); assert.equal(down.funnel.dropped['registry_socrata-permits:austin_http_503'], 1)
})

test('the source: covers only its city and category, builds a bounded server query, and reports a failed read instead of an empty market', async () => {
  const src = austinPermitsSource
  assert.equal(src.covers(AUSTIN), true); assert.equal(src.covers({ ...AUSTIN, where: 'Dallas, Texas' }), false); assert.equal(src.covers({ ...AUSTIN, category: 'dentists', query: 'dentists in Austin' }), false)
  assert.equal(src.covers({ ...AUSTIN, where: 'Austin, TX', category: 'roofers' }), true); assert.equal(src.covers({ ...AUSTIN, where: 'Austin, Texas, USA' }), true)
  for (const where of ['Austin, Minnesota', 'Austin, MN', 'Port Austin, Michigan', 'Lake Austin, Texas']) assert.equal(src.covers({ ...AUSTIN, where }), false, where)
  assert.equal(src.covers({ ...AUSTIN, category: 'solar installers', query: 'solar roofing installers in Austin' }), false, 'the category decides, not words in the query')
  const q = new URL(permitQuery(AUSTIN_PERMITS, ROOF, SINCE))
  assert.equal(q.origin + q.pathname, 'https://data.austintexas.gov/resource/3syk-w9eu.json')
  assert.match(q.searchParams.get('$where')!, /issue_date >= '2026-08-17T00:00:00' AND contractor_company_name IS NOT NULL AND upper\(description\) like '%ROOF%'/)
  assert.equal(q.searchParams.get('$limit'), '500'); assert.equal(q.searchParams.get('$offset'), '0'); assert.equal(new URL(permitQuery(AUSTIN_PERMITS, ROOF, SINCE, 2)).searchParams.get('$offset'), '1000'); assert.match(q.searchParams.get('$select')!, /^issue_date,contractor_company_name,contractor_full_name,/)
  const serve = (status: number, body: string, truncated = false): SafeGet => async () => ({ status, body, truncated })
  const ok = await src.collect(AUSTIN, SINCE, serve(200, JSON.stringify(FX.rows)))
  assert.ok(ok.candidates.length >= 6 && ok.notes.length === 0, JSON.stringify(ok.notes))
  assert.deepEqual((await src.collect(AUSTIN, SINCE, serve(429, ''))).notes, ['throttled'])
  assert.deepEqual((await src.collect(AUSTIN, SINCE, serve(200, '<!doctype html><html>blocked</html>'))).notes, ['not_json'])
  assert.deepEqual((await src.collect(AUSTIN, SINCE, serve(200, '[{', true))).notes, ['oversize'])
  assert.deepEqual((await src.collect(AUSTIN, SINCE, async () => null)).notes, ['unreachable'])
  assert.deepEqual((await src.collect(AUSTIN, SINCE, serve(200, '{"error":"x"}'))).notes, ['not_json'], 'a 200 without rows is unreadable, not empty')
  // a full first page and an unreadable second: what was read is kept, every count says "at least"
  const full = Array.from({ length: 500 }, (_, i) => ({ ...FX.rows.find(r => String(r.contractor_company_name).startsWith('Kanga Roof LLC'))!, permit_number: `P-${i}` }))
  let page = 0
  const partial = await src.collect(AUSTIN, SINCE, async () => (page++ === 0 ? { status: 200, body: JSON.stringify(full) } : { status: 503, body: '' }))
  assert.deepEqual(partial.notes, ['http_503', 'partial']); assert.match(partial.candidates[0].snippet, /^Kanga Roof LLC - at least 500 roofing permits issued/)
  assert.deepEqual((await src.collect({ ...AUSTIN, where: 'Dallas, Texas' }, SINCE, serve(200, '[]'))).notes, ['not_covered'])
})

test("the engine's hunt stage (scan-job researchStagesFor) hands the registry records to hunt under LEAD_ENGINE=research, and only then", async () => {
  const { researchStagesFor } = await import('../lib/research/scan-job.ts')
  const plan = { persona: 'p', decisionMakerTitles: [], triggers: [], askingQueries: [], source: 'fallback' as const }
  const ctx = { db: {} as never, job: { id: 'j', user_id: 't', query: AUSTIN.query }, icp: {} as never, key: 'k', model: () => ({}) as never, isRefusal: () => false,
    http: (async () => ({ status: 200, body: JSON.stringify(FX.rows) })) as SafeGet }
  const run = async (env: string | undefined) => {
    const was = process.env.LEAD_ENGINE
    if (env) process.env.LEAD_ENGINE = env; else delete process.env.LEAD_ENGINE
    try { return await researchStagesFor(ctx).hunt(AUSTIN, plan) } finally { if (was === undefined) delete process.env.LEAD_ENGINE; else process.env.LEAD_ENGINE = was }
  }
  const on = await run('research')
  assert.ok(on.candidates.length >= 6 && on.candidates.every(x => x.via === 'registry' && x.dated === 'registry'), JSON.stringify(on.funnel))
  assert.equal((await run(undefined)).candidates.length, 0)
})
