// MISSION v2 part E: the city business-licence source (lib/research/sources/opendatasoft-licences.ts), on REAL recorded rows of
// Vancouver's business-licences dataset (test/fixtures/research-vancouver-licences.json, 15 Nov 2026). No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { VANCOUVER_LICENCES, licenceQueries, licenceSignals, opendatasoftLicencesSource } from '../lib/research/sources/opendatasoft-licences.ts'
import type { SafeGet } from '../lib/sources/types.ts'

type Row = Record<string, unknown>
const FX = JSON.parse(readFileSync(new URL('./fixtures/research-vancouver-licences.json', import.meta.url), 'utf8')) as { since: string; window: Row[]; prior: Row[]; same: Row[]; renewal_name: string }
const VAN = { city: 'Vancouver', region: 'BC', country: 'CA', category: 'restaurants' }

test('a renewal (same business, same address, last year) is never called new; a new business at an address is "newly licensed"; a business with another licensed location is an additional location', () => {
  const s = licenceSignals(VANCOUVER_LICENCES, 'restaurants', FX.window, FX.prior, FX.same, FX.since)
  const names = s.map(x => x.company)
  assert.ok(!names.includes(FX.renewal_name), `the renewal is not a new location: ${JSON.stringify(names)}`)
  const hunger = s.find(x => x.company === 'Hunger Street')!
  assert.equal(hunger.eventKind, 'new_location_licence')
  assert.match(hunger.eventSummary, /^Hunger Street newly licensed as a restaurant at 1284 KINGSWAY .*Vancouver \(licence 26-\d+, issued 2026-\d\d-\d\d; no licence for this business at this address last year\)$/)
  assert.doesNotMatch(hunger.eventSummary, /opened|second location/i, 'the record cannot tell a new opening from a new owner: it says what it proves')
  const skewers = s.find(x => x.company === 'Skewers Souvlaki Pita Bar')!
  assert.equal(skewers.eventKind, 'additional_location_licence')
  assert.match(skewers.eventSummary, /the business holds 2 licensed restaurant locations in Vancouver this year/)
  for (const x of s) {
    assert.match(x.eventDate, /^\d{4}-\d{2}-\d{2}$/); assert.ok(x.eventDate >= FX.since)
    assert.match(x.sourceUrl, /^https:\/\/opendata\.vancouver\.ca\/explore\/dataset\/business-licences\/table\/\?q=26-/)
    assert.equal(x.personName, null, 'a licence names no person')
  }
  assert.equal(s[0].eventKind, 'additional_location_licence', 'additional locations first')
})

test('the source: three narrow queries; without last year a renewal cannot be told from a new licence, so it returns nothing (fails closed)', async () => {
  const q = licenceQueries(VANCOUVER_LICENCES, 'restaurants', FX.since, '26')
  const w = (u: string) => new URL(u).searchParams.get('where') ?? ''
  assert.equal(w(q.window), `(businesstype="Restaurant") and folderyear="26" and status="Issued" and issueddate >= date'2026-08-17'`)
  assert.match(w(q.renewals(FX.window)), /folderyear="25" and \(\(house="/)
  assert.match(w(q.locations([{ businesstradename: 'He said "hi"' }])), /businesstradename="He said ""hi"""/, 'a quote inside a name is escaped')
  const src = opendatasoftLicencesSource(undefined, () => new Date('2026-11-15T00:00:00Z'))
  assert.equal(src.covers(VAN), true); assert.equal(src.covers({ ...VAN, category: 'dental' }), false)
  const answer = (renewals: 'ok' | 'down'): SafeGet => async (u: string) => {
    const where = w(u)
    if (where.includes('issueddate >=')) return { status: 200, body: JSON.stringify(FX.window) }
    if (where.includes('folderyear="25"')) return renewals === 'ok' ? { status: 200, body: JSON.stringify(FX.prior) } : { status: 503, body: '' }
    return { status: 200, body: JSON.stringify(FX.same) }
  }
  const ok = await src.collect(VAN, FX.since, answer('ok'))
  assert.ok(ok.signals.length >= 3 && ok.notes.length === 0, JSON.stringify(ok.notes))
  assert.ok(!ok.signals.some(x => x.company === FX.renewal_name))
  const down = await src.collect(VAN, FX.since, answer('down'))
  assert.deepEqual(down, { signals: [], notes: ['http_503', 'renewals_unknown'] })
  assert.deepEqual((await src.collect(VAN, FX.since, async () => ({ status: 200, body: '[{', truncated: true }))).notes, ['oversize'])
})
