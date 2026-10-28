// Finish unfinished candidates before they are returned held (modelled on scan 6: Embedd = no event date, Querio = no sales-hiring evidence). SYNTHETIC pages and boards through the
// real runner / verifier / window gate / sales-hiring gate: no network, no key, no credits. Nothing here loosens a gate: a date found this way is judged by the same window gate.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import { resolveStructuredDate, kindsFor } from '../lib/scan/structured-date.ts'
import { applySalesHiringGate } from '../lib/scan/sales-hiring-gate.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'

const REQUEST = 'Find London UK B2B startups that opened a new office within the past 90 days.'
const ICP = { summary: 'London B2B startups', who: ['Founder'], industries: ['software'], sizes: [], where: ['London, UK'], signals: ['opened a new office'], exclude: [], window_days: 90 }
const filler = ' The team builds developer tooling for London engineering teams and welcomes visitors every week.'.repeat(6)
const URL = 'https://news.example/embedd-office'
const QUOTE = 'Embedd opened a new office in Shoreditch, London for its growing engineering team'
const ld = (o: object) => JSON.stringify(o)
const EVENT = (startDate: string, organizer = 'Embedd') => ld({ '@context': 'https://schema.org', '@type': 'Event', name: 'Embedd office opening', startDate, organizer: { '@type': 'Organization', name: organizer }, location: { '@type': 'Place', name: 'Embedd Shoreditch office', address: { '@type': 'PostalAddress', streetAddress: '1 Old Street', addressLocality: 'London', addressCountry: 'GB' } } })
const WEBINAR = (startDate: string, organizer = 'Embedd') => ld({ '@context': 'https://schema.org', '@type': 'Event', name: 'Embedd product webinar: shipping faster', startDate, eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode', location: { '@type': 'VirtualLocation', url: 'https://embedd.example/webinar' }, organizer: { '@type': 'Organization', name: organizer } })
function fx(structured: string[] | undefined, over: { published?: string; quote?: string } = {}): Fixture {
  const c: Cand = { company: 'Embedd', signal: 'opened a new London office', source_url: URL, excerpt: over.quote ?? QUOTE, event_date: null }
  return { request: REQUEST, modelIcp: ICP, modelQueries: ['london startup opens office'], hits: [{ url: URL, title: 'Embedd', snippet: QUOTE, date: null }], tfPages: {},
    own: { [URL]: { title: 'Embedd opens in Shoreditch', text: `${over.quote ?? QUOTE}.${filler}`, ...(over.published ? { published: over.published } : {}), ...(structured ? { structured } : {}) } }, extraction: [c] }
}
const row = async (f: Fixture) => { const x = await runFixture(f); return { x, r: x.db.prepare('SELECT event_date, review_reason, timing_note FROM leads').get() as { event_date: string | null; review_reason: string | null; timing_note: string | null } } }

test('EMBEDD: an undated candidate whose page declares an in-window Event startDate for Embedd is finished, judged by the window gate, and qualifies', async () => {
  const { r } = await row(fx([EVENT(daysAgo(9))]))
  assert.equal(r.review_reason, null, JSON.stringify(r)); assert.equal(r.event_date, daysAgo(9)); assert.match(r.timing_note ?? '', /structured data \(schema\.org Event\), not from the quote/)
})
test('EMBEDD: nothing found -> stays held with the specific reason (outside_window_undated), no date invented', async () => {
  for (const structured of [undefined, [], ['{not json']]) {
    const { r } = await row(fx(structured))
    assert.equal(r.review_reason, 'outside_window_undated'); assert.equal(r.event_date, null)
  }
})
test('the window gate still applies to a structured date: stale or future dates are held with their own reason', async () => {
  assert.equal((await row(fx([EVENT(daysAgo(200))]))).r.review_reason, 'outside_window')
  assert.equal((await row(fx([EVENT(daysAgo(-40))]))).r.review_reason, 'event_date_future_date')
})
test('identity: an Event organised by another company, a publication/modified stamp, two different dates, or a JobPosting date on an opening claim never date the lead', async () => {
  for (const structured of [
    [EVENT(daysAgo(9), 'Initech')],
    [ld({ '@type': 'NewsArticle', headline: 'Embedd office', datePublished: daysAgo(9), dateModified: daysAgo(3) })],
    [EVENT(daysAgo(9)), EVENT(daysAgo(30))],
    [ld({ '@type': 'JobPosting', title: 'Engineer', datePosted: daysAgo(9), hiringOrganization: { '@type': 'Organization', name: 'Embedd' } })],
  ]) { const { r } = await row(fx(structured)); assert.equal(r.review_reason, 'outside_window_undated', structured[0]); assert.equal(r.event_date, null) }
})
test('resolveStructuredDate: @graph and nested nodes are read; kind must fit the claim; one distinct date only', () => {
  const g = ld({ '@graph': [{ '@type': 'WebSite' }, { '@type': ['Thing', 'BusinessEvent'], name: 'Embedd office opening', startDate: '2026-10-01T09:00:00+01:00', location: { '@type': 'Place', name: 'Embedd London office' } }] })
  assert.deepEqual(resolveStructuredDate([g], 'Embedd Ltd', 'opened a new office in London'), { date: '2026-10-01', kind: 'Event' })
  assert.equal(resolveStructuredDate([g], 'Embedd', 'raised a seed round'), null, 'a funding claim is never dated by an Event')
  const jp = ld({ '@type': 'JobPosting', title: 'Sales Account Executive', datePosted: '2026-10-02', hiringOrganization: { name: 'Embedd' } })
  assert.deepEqual(resolveStructuredDate([jp], 'Embedd', 'is hiring a sales account executive'), { date: '2026-10-02', kind: 'JobPosting' })
  assert.equal(resolveStructuredDate([jp], 'Embedd', 'is hiring an account executive'), null, 'one word of the title missing from the claim: the role is not confirmed')
  assert.equal(resolveStructuredDate([jp], 'Embedd', 'is hiring a backend engineer'), null, 'a posting for another role is not this claim')
  assert.equal(resolveStructuredDate([jp], 'Embedd', 'opened a new office'), null)
  assert.equal(resolveStructuredDate([ld({ '@type': 'Event', name: 'Embedd', startDate: '2026-02-30' })], 'Embedd', 'opened'), null, 'not a real calendar day')
  assert.deepEqual(kindsFor('raised a seed round'), [])
})
test('bounded: at most 6 undated candidates are finished per scan', async () => {
  const { finishUndatedLeads } = await import('../lib/scan/structured-date.ts')
  const leads = Array.from({ length: 9 }, (_, i) => ({ company: 'Embedd', signal: 'opened a new office', excerpt: 'opened a new office in London', source_url: `https://e.example/${i}`, event_date: null as string | null }))
  let fetched = 0
  const done = await finishUndatedLeads(leads, async () => { fetched++; return { structured: [EVENT('2026-10-20')] } })
  assert.equal(fetched, 6); assert.equal(done.length, 6); assert.equal(leads.filter(l => l.event_date).length, 6)
})

// ---- QUERIO: no verified sales-hiring evidence. The gate's own enrichment (ATS board + careers page) decides; same gate, stubbed boards. ----
const NOW = Date.parse('2026-10-28T12:00:00Z')
const dIso = (n: number) => new Date(NOW - n * 86_400_000).toISOString()
const SEED_REQ = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days and are hiring sales staff.'
const SEED_ICP = JSON.stringify({ summary: 's', where: ['London, UK'], who: ['Founder'], signals: ['announced seed funding', 'hiring sales staff'], exclude: [] })
function querio() {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', query = ?, icp = ? WHERE id = ?").run(SEED_REQ, SEED_ICP, jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, confidence, score, why, event_date, date_status) VALUES ('L1', ?, '', 'Querio', 'querio.ai', 'raised a seed round', 'https://news.example/querio', 'Querio, a London analytics startup, raised a 3m GBP seed round this month', 80, 70, 'w', ?, 'unverified')").run(jobId, dIso(12).slice(0, 10))
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('D1', 'L1', 'u1', 'sitecrawl', 'domain', 'querio.ai|evidence_own_domain', 'domain-basis-v1:evidence_own_domain', 90, 'https://news.example/querio', '2026-10-20', 10)").run()
  db.prepare("UPDATE scan_jobs SET status = 'done', verified = 1, needs_review = 0 WHERE id = ?").run(jobId)
  return { db, job: { id: jobId, user_id: 'u1', query: SEED_REQ, icp: SEED_ICP } }
}
const GH = 'https://boards-api.greenhouse.io/v1/boards/querio'
const serve = (m: Record<string, unknown>) => (async (u: RequestInfo | URL) => (m[String(u)] ? new Response(JSON.stringify(m[String(u)]), { status: 200 }) : new Response('nope', { status: 404 }))) as never
test('QUERIO: its public Greenhouse board lists a dated London sales posting bound to querio.ai -> it keeps its place (qualifies on that evidence)', async () => {
  const { db, job } = querio()
  const r = await applySalesHiringGate(db, job, serve({ [`${GH}/jobs`]: { jobs: [{ id: 7, title: 'Account Executive' }] }, [`${GH}/jobs/7`]: { id: 7, title: 'Account Executive', first_published: dIso(10), absolute_url: 'https://boards.greenhouse.io/querio/jobs/7', location: { name: 'London, UK' }, content: '&lt;p&gt;Querio is hiring. Write to jobs@querio.ai&lt;/p&gt;' } }), { now: NOW })
  assert.equal(r.passed, 1); assert.equal((db.prepare("SELECT review_reason FROM leads WHERE id = 'L1'").get() as { review_reason: string | null }).review_reason, null)
})
test('QUERIO: nothing found on any board or careers page -> stays held with the specific reason no_sales_hiring_evidence', async () => {
  const { db, job } = querio()
  const r = await applySalesHiringGate(db, job, serve({}), { now: NOW })
  assert.equal(r.demoted, 1); assert.equal((db.prepare("SELECT review_reason FROM leads WHERE id = 'L1'").get() as { review_reason: string | null }).review_reason, 'no_sales_hiring_evidence')
})

// ---- #307 review: the date must come from text about the SAME event, not the same company or page ----
test('INSTINCT CASE: a company page with a dated WEBINAR and an undated office-opening claim -> the claim stays undated and held; the webinar date is never borrowed', async () => {
  for (const structured of [[WEBINAR(daysAgo(9))], [WEBINAR(daysAgo(9)), ld({ '@type': 'Organization', name: 'Embedd' })]]) {
    const { r } = await row(fx(structured))
    assert.equal(r.event_date, null, 'no date borrowed from the webinar'); assert.equal(r.review_reason, 'outside_window_undated'); assert.equal(r.timing_note, null)
  }
  assert.equal(resolveStructuredDate([WEBINAR('2026-10-10')], 'Embedd', 'opened a new office in Shoreditch, London', ['London, UK']), null)
})
test('POSITIVE: a dated OFFICE-OPENING Event in the claim\'s place dates the claim; with a webinar on the same page, only the opening\'s date is used', async () => {
  const { r } = await row(fx([EVENT(daysAgo(9))])); assert.equal(r.event_date, daysAgo(9)); assert.equal(r.review_reason, null)
  const mixed = await row(fx([WEBINAR(daysAgo(2)), EVENT(daysAgo(9))]))
  assert.equal(mixed.r.event_date, daysAgo(9), 'the opening\'s date, not the webinar\'s'); assert.equal(mixed.r.review_reason, null)
})
test('same event TYPE is not enough - the PLACE must match: an office opening in another city, or an Event with a place but none in common with the claim, never dates it', () => {
  const other = ld({ '@type': 'Event', name: 'Embedd office opening', startDate: '2026-10-05', organizer: { name: 'Embedd' }, location: { '@type': 'Place', name: 'Embedd Manchester office', address: { '@type': 'PostalAddress', addressLocality: 'Manchester' } } })
  assert.equal(resolveStructuredDate([other], 'Embedd', 'opened a new office in Shoreditch, London', ['London, UK']), null)
  const noPlace = ld({ '@type': 'Event', name: 'Embedd office opening', startDate: '2026-10-05', organizer: { name: 'Embedd' } })
  assert.equal(resolveStructuredDate([noPlace], 'Embedd', 'opened a new office in Shoreditch, London', ['London, UK']), null, 'an opening with no place at all cannot be tied to this office')
  const launch = ld({ '@type': 'Event', name: 'Embedd product launch', startDate: '2026-10-05', organizer: { name: 'Embedd' }, location: { '@type': 'Place', name: 'London' } })
  assert.equal(resolveStructuredDate([launch], 'Embedd', 'opened a new office in London', ['London, UK']), null, 'a product launch is not an office opening')
})
test('an online webinar claim IS dated by the webinar Event (same type); a conference claim by a conference', () => {
  assert.deepEqual(resolveStructuredDate([WEBINAR('2026-10-10')], 'Embedd', 'is hosting a webinar on shipping faster'), { date: '2026-10-10', kind: 'Event' })
  const conf = ld({ '@type': 'Event', name: 'Embedd developer summit', startDate: '2026-10-12', organizer: { name: 'Embedd' } })
  assert.deepEqual(resolveStructuredDate([conf], 'Embedd', 'is running a developer summit'), { date: '2026-10-12', kind: 'Event' })
})

// ---- #307 review 2: the event's own place has to agree with the claim's place; a shared country / region / city word is not enough ----
const CLAIM = 'opened a new office in Shoreditch, London'
const PLACE = (name: string, locality: string, country = 'United Kingdom', region = 'England', startDate = '2026-10-19') => ld({ '@context': 'https://schema.org', '@type': 'Event', name: `${name} office opening`, startDate, organizer: { '@type': 'Organization', name: 'Embedd' }, location: { '@type': 'Place', name: `${name} office`, address: { '@type': 'PostalAddress', streetAddress: '1 High Street', addressLocality: locality, addressRegion: region, postalCode: 'N1 1AA', addressCountry: country } } })
test('INSTINCT REPRO 1: a Manchester office opening (addressCountry "United Kingdom") never dates a Shoreditch, London claim - a shared country is not a shared place', () => {
  assert.equal(resolveStructuredDate([PLACE('Embedd Manchester', 'Manchester')], 'Embedd', CLAIM, ['London, United Kingdom']), null)
  assert.equal(resolveStructuredDate([PLACE('Embedd Manchester', 'Manchester', 'GB', 'Greater Manchester')], 'Embedd', CLAIM, ['London, UK']), null)
  assert.equal(resolveStructuredDate([PLACE('Embedd Edinburgh', 'Edinburgh', 'United Kingdom', 'Scotland')], 'Embedd', 'opened a new office in London', ['London, United Kingdom']), null)
})
test('INSTINCT REPRO 2: a Camden, London office never dates a Shoreditch, London opening - a shared city word is not a shared neighbourhood', () => {
  assert.equal(resolveStructuredDate([PLACE('Embedd Camden', 'London')], 'Embedd', CLAIM, ['London, United Kingdom']), null)
  assert.equal(resolveStructuredDate([PLACE('Embedd Camden', 'London')], 'Embedd', CLAIM, []), null)
})
test('AMBIGUOUS: an event that says only "London" cannot confirm a claim that names Shoreditch -> undated and held; the same event does date a claim that says only London', () => {
  assert.equal(resolveStructuredDate([PLACE('Embedd', 'London')], 'Embedd', CLAIM, ['London, United Kingdom']), null)
  assert.deepEqual(resolveStructuredDate([PLACE('Embedd', 'London')], 'Embedd', 'opened a new office in London', ['London, United Kingdom']), { date: '2026-10-19', kind: 'Event' })
})
test('POSITIVES: the Shoreditch event dates the Shoreditch claim (with or without the request place, any country spelling); the request\'s place stands in for a claim that names none', () => {
  for (const country of ['United Kingdom', 'GB', 'UK']) assert.deepEqual(resolveStructuredDate([PLACE('Embedd Shoreditch', 'London', country)], 'Embedd', CLAIM, ['London, United Kingdom']), { date: '2026-10-19', kind: 'Event' }, country)
  assert.deepEqual(resolveStructuredDate([PLACE('Embedd Shoreditch', 'London')], 'Embedd', CLAIM, []), { date: '2026-10-19', kind: 'Event' })
  assert.deepEqual(resolveStructuredDate([PLACE('Embedd Shoreditch', 'London')], 'Embedd', 'opened a new office', ['London, United Kingdom']), { date: '2026-10-19', kind: 'Event' }, 'a claim with no place of its own: the request place (London) is the claim place')
  // with both offices declared on the page, only the matching one dates the claim
  assert.deepEqual(resolveStructuredDate([PLACE('Embedd Manchester', 'Manchester', 'United Kingdom', 'England', '2026-09-01'), PLACE('Embedd Shoreditch', 'London')], 'Embedd', CLAIM, ['London, United Kingdom']), { date: '2026-10-19', kind: 'Event' })
})
test('FULL RUN: Manchester and Camden events on the page leave the Shoreditch claim undated and held (no timing note); the Shoreditch event dates it', async () => {
  for (const structured of [[PLACE('Embedd Manchester', 'Manchester')], [PLACE('Embedd Camden', 'London')], [PLACE('Embedd Manchester', 'Manchester'), PLACE('Embedd Camden', 'London')]]) {
    const { r } = await row(fx(structured)); assert.equal(r.event_date, null); assert.equal(r.review_reason, 'outside_window_undated'); assert.equal(r.timing_note, null)
  }
  const ok = await row(fx([PLACE('Embedd Shoreditch', 'London', 'United Kingdom', 'England', daysAgo(9))]))
  assert.equal(ok.r.event_date, daysAgo(9)); assert.equal(ok.r.review_reason, null)
})

// ---- #307 review 3: place identity is independent of letter case (lowercase shoreditch must not borrow Camden) ----
const CASES = ['opened a new office in shoreditch, london', 'opened a new office in Shoreditch, London', 'opened a new office in SHOREDITCH, LONDON', 'opened a new office in ShoreDitch, london', 'opened a new office in shoreditch london for its growing engineering team', 'OPENED A NEW OFFICE IN SHOREDITCH LONDON', '  opened a new office in  Shoreditch ,  London . ']
const WHERES = [['London, United Kingdom'], ['london, united kingdom'], ['LONDON, UK'], []]
test('INSTINCT REPRO 3: a lowercase / mixed / ALL CAPS "shoreditch" claim never borrows a Camden, London event - every casing, with and without the request place', () => {
  const camden = [PLACE('Embedd Camden', 'London'), PLACE('embedd camden', 'london'), PLACE('EMBEDD CAMDEN', 'LONDON', 'UNITED KINGDOM', 'ENGLAND')]
  for (const c of CASES) for (const w of WHERES) for (const ev of camden) assert.equal(resolveStructuredDate([ev], 'Embedd', c, w), null, `${JSON.stringify(c)} ${JSON.stringify(w)}`)
})
test('every casing also refuses Manchester and a London-only event for a Shoreditch claim', () => {
  for (const c of CASES) for (const w of WHERES) {
    assert.equal(resolveStructuredDate([PLACE('Embedd Manchester', 'Manchester')], 'Embedd', c, w), null, c)
    assert.equal(resolveStructuredDate([PLACE('embedd manchester', 'MANCHESTER')], 'Embedd', c, w), null, c)
    assert.equal(resolveStructuredDate([PLACE('Embedd', 'London')], 'Embedd', c, w), null, `ambiguous (London only): ${c}`)
  }
})
test('MATCHING POSITIVES in every casing, on the claim side and the event side: Shoreditch dates the Shoreditch claim', () => {
  const shoreditch = [PLACE('Embedd Shoreditch', 'London'), PLACE('embedd shoreditch', 'london'), PLACE('EMBEDD SHOREDITCH', 'LONDON', 'UNITED KINGDOM', 'ENGLAND'), PLACE(' Embedd  Shoreditch ', ' London. ')]
  for (const c of CASES) for (const w of WHERES) for (const ev of shoreditch) assert.deepEqual(resolveStructuredDate([ev], 'Embedd', c, w), { date: '2026-10-19', kind: 'Event' }, `${JSON.stringify(c)} ${JSON.stringify(w)}`)
  for (const c of ['opened a new office in london', 'opened a new office in LONDON', 'opened a new office']) assert.deepEqual(resolveStructuredDate([PLACE('embedd camden', 'LONDON')], 'Embedd', c, ['london, united kingdom']), { date: '2026-10-19', kind: 'Event' }, `a claim that names only London is dated by any London event: ${c}`)
})
test('FULL RUN, lowercase claim: a Camden event leaves "opened a new office in shoreditch, london" undated and held; the Shoreditch event dates it', async () => {
  const lower = 'Embedd opened a new office in shoreditch, london for its growing engineering team'
  const held = await row(fx([PLACE('Embedd Camden', 'London')], { quote: lower }))
  assert.equal(held.r.event_date, null); assert.equal(held.r.review_reason, 'outside_window_undated'); assert.equal(held.r.timing_note, null)
  const ok = await row(fx([PLACE('Embedd Shoreditch', 'London', 'United Kingdom', 'England', daysAgo(9))], { quote: lower }))
  assert.equal(ok.r.event_date, daysAgo(9)); assert.equal(ok.r.review_reason, null)
})

// ---- #307 review 4: whole place names, not shared words ----
const CASINGS = (s: string) => [s, s.toLowerCase(), s.toUpperCase(), s.replace(/\b(\w)(\w*)/g, (_, a, b) => a.toLowerCase() + b.toUpperCase())]
const EV = (placeName: string, locality = 'London', country = 'United Kingdom') => PLACE(`Embedd ${placeName}`, locality, country, country === 'United States' ? 'New York' : 'England')
const CLAIM_OF = (place: string) => `opened a new office in ${place}, London`
test('INSTINCT REPRO 4: an East Kensington claim is never dated by a West Kensington event (or a bare Kensington one) - whole place names, qualifiers included, in every casing', () => {
  for (const claimPlace of CASINGS('East Kensington')) for (const w of WHERES) {
    for (const evPlace of CASINGS('West Kensington')) assert.equal(resolveStructuredDate([EV(evPlace)], 'Embedd', CLAIM_OF(claimPlace), w), null, `${claimPlace} vs ${evPlace}`)
    for (const evPlace of CASINGS('Kensington')) assert.equal(resolveStructuredDate([EV(evPlace)], 'Embedd', CLAIM_OF(claimPlace), w), null, `bare ${evPlace} is not ${claimPlace}`)
    for (const evPlace of CASINGS('South Kensington')) assert.equal(resolveStructuredDate([EV(evPlace)], 'Embedd', CLAIM_OF(claimPlace), w), null)
  }
  // and the reverse: a bare Kensington claim is not dated by East or West Kensington
  assert.equal(resolveStructuredDate([EV('East Kensington')], 'Embedd', CLAIM_OF('Kensington'), ['London, UK']), null)
  assert.equal(resolveStructuredDate([EV('West Kensington')], 'Embedd', CLAIM_OF('Kensington'), ['London, UK']), null)
})
test('directional / qualifier variants never match each other, in every casing: North vs South Shields, Upper vs Lower Manhattan, New vs Old, East vs West', () => {
  const pairs: [string, string, string, string][] = [['North Shields', 'South Shields', 'Newcastle', 'United Kingdom'], ['Upper Manhattan', 'Lower Manhattan', 'New York', 'United States'], ['New Cross', 'Old Cross', 'London', 'United Kingdom'], ['East Village', 'West Village', 'New York', 'United States'], ['Upper Norwood', 'Lower Norwood', 'London', 'United Kingdom']]
  for (const [a, b, city, country] of pairs) for (const ca of CASINGS(a)) for (const cb of CASINGS(b)) {
    const claim = `opened a new office in ${ca}, ${city}`
    assert.equal(resolveStructuredDate([EV(cb, city, country)], 'Embedd', claim, [`${city}, ${country}`]), null, `${ca} vs ${cb}`)
    assert.equal(resolveStructuredDate([EV(cb, city, country)], 'Embedd', claim, []), null, `${ca} vs ${cb} (no request place)`)
  }
})
test('MATCHING multiword places still date the claim, in every casing on both sides: East Kensington = East Kensington, North Shields = North Shields, Lower Manhattan, New Cross, Shoreditch', () => {
  const same: [string, string, string][] = [['East Kensington', 'London', 'United Kingdom'], ['North Shields', 'Newcastle', 'United Kingdom'], ['Lower Manhattan', 'New York', 'United States'], ['New Cross', 'London', 'United Kingdom'], ['Shoreditch', 'London', 'United Kingdom']]
  for (const [place, city, country] of same) for (const cc of CASINGS(place)) for (const ce of CASINGS(place)) for (const w of [[`${city}, ${country}`], []]) {
    const claim = `opened a new office in ${cc}, ${city}`
    assert.deepEqual(resolveStructuredDate([EV(ce, city, country)], 'Embedd', claim, w), { date: '2026-10-19', kind: 'Event' }, `${cc} = ${ce} ${JSON.stringify(w)}`)
  }
  // a claim written without a comma still binds the whole phrase
  assert.deepEqual(resolveStructuredDate([EV('East Kensington')], 'Embedd', 'opened a new office in east kensington london for its growing team', ['London, UK']), { date: '2026-10-19', kind: 'Event' })
  assert.equal(resolveStructuredDate([EV('West Kensington')], 'Embedd', 'opened a new office in east kensington london for its growing team', ['London, UK']), null)
})
test('FULL RUN: a West Kensington event leaves the East Kensington claim undated and held; the East Kensington event dates it', async () => {
  const claim = 'Embedd opened a new office in East Kensington, London for its growing engineering team'
  const held = await row(fx([PLACE('Embedd West Kensington', 'London')], { quote: claim }))
  assert.equal(held.r.event_date, null); assert.equal(held.r.review_reason, 'outside_window_undated'); assert.equal(held.r.timing_note, null)
  const ok = await row(fx([PLACE('Embedd East Kensington', 'London', 'United Kingdom', 'England', daysAgo(9))], { quote: claim }))
  assert.equal(ok.r.event_date, daysAgo(9)); assert.equal(ok.r.review_reason, null)
})
test('ROLE identity (Instinct note): one shared generic role word is not the posting - Account Manager does not date an Account Executive claim', () => {
  const jp = (title: string) => ld({ '@type': 'JobPosting', title, datePosted: '2026-10-02', hiringOrganization: { name: 'Embedd' } })
  assert.equal(resolveStructuredDate([jp('Account Manager')], 'Embedd', 'is hiring an account executive'), null)
  assert.equal(resolveStructuredDate([jp('Sales Manager')], 'Embedd', 'is hiring a sales executive'), null)
  assert.equal(resolveStructuredDate([jp('Senior Account Executive')], 'Embedd', 'is hiring an account executive'), null, 'seniority is part of the role: ambiguous, so undated')
  assert.deepEqual(resolveStructuredDate([jp('Account Executive')], 'Embedd', 'is hiring an account executive'), { date: '2026-10-02', kind: 'JobPosting' })
  assert.deepEqual(resolveStructuredDate([jp('Account Executive - London')], 'Embedd', 'is hiring an account executive in London'), { date: '2026-10-02', kind: 'JobPosting' }, 'a location tag after a dash is not part of the role')
  assert.deepEqual(resolveStructuredDate([jp('ACCOUNT EXECUTIVES')], 'Embedd', 'is hiring account executive'), { date: '2026-10-02', kind: 'JobPosting' })
})

// ---- #307 review 5: the request's own words must never cancel the finer-place comparison ----
const PAIRS: [string, string, string, string, string][] = [['East Kensington', 'West Kensington', 'London', 'UK', 'United Kingdom'], ['North Shields', 'South Shields', 'Newcastle', 'UK', 'United Kingdom'], ['Upper Manhattan', 'Lower Manhattan', 'New York', 'NY, USA', 'United States'], ['New Cross', 'Old Cross', 'London', 'UK', 'United Kingdom'], ['East Village', 'West Village', 'New York', 'NY, USA', 'United States'], ['Upper Norwood', 'Lower Norwood', 'London', 'UK', 'United Kingdom']]
test('INSTINCT REPRO 5: request "East Kensington, London, UK" + East Kensington claim + West Kensington event -> undated and held (the request cannot cancel the qualifier)', async () => {
  assert.equal(resolveStructuredDate([PLACE('Embedd West Kensington', 'London')], 'Embedd', 'opened a new office in East Kensington, London', ['East Kensington, London, UK']), null)
  for (const q of CASINGS('East Kensington, London, UK')) for (const c of CASINGS('East Kensington')) for (const e of CASINGS('West Kensington'))
    assert.equal(resolveStructuredDate([EV(e)], 'Embedd', CLAIM_OF(c), [q]), null, `${q} | ${c} | ${e}`)
  const claim = 'Embedd opened a new office in East Kensington, London for its growing engineering team'
  const held = await row(fx([PLACE('Embedd West Kensington', 'London')], { quote: claim }))
  assert.equal(held.r.review_reason, 'outside_window_undated') // (this run's request is the fixture's London request; the resolver cases above carry the East Kensington request)
})
test('EVERY request-place variant x EVERY directional pair x every casing: the event\'s finer place is compared whole against the claim\'s - request = claim place, request = event place, request = bare city, no request', () => {
  for (const [a, b, city, reg, country] of PAIRS) for (const ca of CASINGS(a)) for (const eb of CASINGS(b)) {
    const claim = `opened a new office in ${ca}, ${city}`
    const requests: string[][] = [[`${a}, ${city}, ${reg}`], [`${b}, ${city}, ${reg}`], [`${city}, ${reg}`], [`${city}, ${country}`], [`${a}, ${city}, ${country}`], [`${b}, ${city}, ${country}`], [`${a}, ${city}`], [`${b}, ${city}`], [], [`${a}, ${city}, ${reg}`.toUpperCase()], [`${b}, ${city}, ${reg}`.toLowerCase()]]
    for (const req of requests) assert.equal(resolveStructuredDate([EV(eb, city, country)], 'Embedd', claim, req), null, `${ca} claim | ${eb} event | request ${JSON.stringify(req)}`)
  }
})
test('a claim with NO place of its own: the request\'s finer place binds the event - West Kensington cannot date a request for East Kensington, and an event that only says "London" is ambiguous', () => {
  for (const req of CASINGS('East Kensington, London, UK')) {
    assert.equal(resolveStructuredDate([EV('West Kensington')], 'Embedd', 'opened a new office', [req]), null, req)
    assert.equal(resolveStructuredDate([EV('Kensington')], 'Embedd', 'opened a new office', [req]), null, req)
    assert.equal(resolveStructuredDate([PLACE('Embedd', 'London')], 'Embedd', 'opened a new office', [req]), null, `London-only: ${req}`)
    assert.deepEqual(resolveStructuredDate([EV('East Kensington')], 'Embedd', 'opened a new office', [req]), { date: '2026-10-19', kind: 'Event' }, req)
  }
  // a claim and a request that name DIFFERENT finer places can be dated by neither event
  assert.equal(resolveStructuredDate([EV('East Kensington')], 'Embedd', CLAIM_OF('Camden'), ['East Kensington, London, UK']), null)
  assert.equal(resolveStructuredDate([EV('Camden')], 'Embedd', CLAIM_OF('Camden'), ['East Kensington, London, UK']), null)
})
test('POSITIVES stay green with every request-place variant that does not contradict: request = claim place, request = bare city, no request - all casings', () => {
  for (const [a, , city, reg, country] of PAIRS) for (const ca of CASINGS(a)) for (const ea of CASINGS(a)) {
    const claim = `opened a new office in ${ca}, ${city}`
    for (const req of [[`${a}, ${city}, ${reg}`], [`${city}, ${reg}`], [`${city}, ${country}`], [`${a}, ${city}, ${country}`], [`${a}, ${city}`.toUpperCase()], []]) assert.deepEqual(resolveStructuredDate([EV(ea, city, country)], 'Embedd', claim, req), { date: '2026-10-19', kind: 'Event' }, `${ca} | ${ea} | ${JSON.stringify(req)}`)
  }
})

test('"Greater London" as the request place is the city London, not a finer place; a Shoreditch claim still needs a Shoreditch event', () => {
  assert.deepEqual(resolveStructuredDate([EV('Shoreditch')], 'Embedd', CLAIM_OF('Shoreditch'), ['Greater London, UK']), { date: '2026-10-19', kind: 'Event' })
  assert.equal(resolveStructuredDate([EV('Camden')], 'Embedd', CLAIM_OF('Shoreditch'), ['Greater London, UK']), null)
})

// ---- #307 review 6: the event's STRUCTURED country / region must agree (London, Ontario is not London, UK) ----
const LONDON_UK_CLAIM = 'Embedd opened a new office in London, UK'
test('INSTINCT REPRO 6: addressCountry CA / addressRegion Ontario never dates a London, UK claim; the GB / England control does', () => {
  const ev = (country: unknown, region: unknown) => ld({ '@type': 'Event', name: 'Embedd office opening', startDate: '2026-10-19', organizer: { name: 'Embedd' }, location: { '@type': 'Place', name: 'Embedd London office', address: { '@type': 'PostalAddress', addressLocality: 'London', addressCountry: country, addressRegion: region } } })
  assert.deepEqual(resolveStructuredDate([ev('GB', 'England')], 'Embedd', LONDON_UK_CLAIM, ['London, UK']), { date: '2026-10-19', kind: 'Event' }, 'the London, UK control')
  for (const [country, region] of [['CA', 'Ontario'], ['Canada', 'Ontario'], ['CA', 'ON'], ['ca', 'on'], ['CANADA', 'ONTARIO'], [{ '@type': 'Country', name: 'Canada' }, 'Ontario'], ['CA', undefined], [undefined, 'Ontario'], [undefined, 'ON'], ['CAN', 'Ontario']] as const) {
    for (const where of [['London, UK'], ['london, united kingdom'], ['LONDON, UK'], []]) assert.equal(resolveStructuredDate([ev(country, region)], 'Embedd', LONDON_UK_CLAIM, where), null, `${JSON.stringify([country, region])} ${JSON.stringify(where)}`)
    assert.equal(resolveStructuredDate([ev(country, region)], 'Embedd', 'Embedd opened a new office in London', ['London, UK']), null, `request-only UK: ${JSON.stringify([country, region])}`)
  }
})
test('country / region spellings that AGREE keep dating (GB, UK, United Kingdom, England, Scotland-only for a Scottish claim), and a missing country stays the old behaviour (no conflict is claimed)', () => {
  const ev = (country: unknown, region: unknown, locality = 'London') => ld({ '@type': 'Event', name: 'Embedd office opening', startDate: '2026-10-19', organizer: { name: 'Embedd' }, location: { '@type': 'Place', name: 'Embedd London office', address: { '@type': 'PostalAddress', addressLocality: locality, addressCountry: country, addressRegion: region } } })
  for (const [country, region] of [['GB', 'England'], ['UK', 'England'], ['United Kingdom', 'England'], ['GBR', undefined], [{ name: 'United Kingdom' }, 'ENGLAND'], ['gb', 'england'], [undefined, undefined], [undefined, 'England']] as const)
    assert.deepEqual(resolveStructuredDate([ev(country, region)], 'Embedd', LONDON_UK_CLAIM, ['London, UK']), { date: '2026-10-19', kind: 'Event' }, JSON.stringify([country, region]))
  // a London, Ontario claim IS dated by the Ontario event and not by the UK one
  const onClaim = 'Embedd opened a new office in London, Ontario'
  assert.deepEqual(resolveStructuredDate([ev('CA', 'Ontario')], 'Embedd', onClaim, ['London, Ontario, Canada']), { date: '2026-10-19', kind: 'Event' })
  assert.equal(resolveStructuredDate([ev('GB', 'England')], 'Embedd', onClaim, ['London, Ontario, Canada']), null)
  // a US lead: New York, NY event vs a New York claim; a Canadian-province event never dates it
  assert.deepEqual(resolveStructuredDate([ev('US', 'NY', 'New York')], 'Embedd', 'opened a new office in New York, NY', ['New York, NY, USA']), { date: '2026-10-19', kind: 'Event' })
  assert.equal(resolveStructuredDate([ev('CA', 'Ontario', 'New York')], 'Embedd', 'opened a new office in New York, NY', ['New York, NY, USA']), null)
  // a different UK constituent region disagrees too (Scotland vs England)
  assert.equal(resolveStructuredDate([ev('GB', 'Scotland')], 'Embedd', 'opened a new office in London, England', ['London, England']), null)
})
test('FULL RUN: a London, Ontario event leaves the London, UK claim undated and held (no timing note); the London, UK event dates it', async () => {
  const ev = (country: string, region: string, startDate: string) => ld({ '@context': 'https://schema.org', '@type': 'Event', name: 'Embedd office opening', startDate, organizer: { '@type': 'Organization', name: 'Embedd' }, location: { '@type': 'Place', name: 'Embedd London office', address: { '@type': 'PostalAddress', addressLocality: 'London', addressCountry: country, addressRegion: region } } })
  const claim = 'Embedd opened a new office in London, UK for its growing engineering team'
  const held = await row(fx([ev('CA', 'Ontario', daysAgo(9))], { quote: claim }))
  assert.equal(held.r.event_date, null); assert.equal(held.r.review_reason, 'outside_window_undated'); assert.equal(held.r.timing_note, null)
  const ok = await row(fx([ev('GB', 'England', daysAgo(9))], { quote: claim }))
  assert.equal(ok.r.event_date, daysAgo(9)); assert.equal(ok.r.review_reason, null)
})

// ---- #307 review 7: an event (or request) whose own country and region contradict each other describes no real place and dates nothing ----
test('INSTINCT REPRO 7: an event that contradicts itself (Canada + England, US + Ontario, UK + NY, CA + Scotland) never dates a claim; agreeing pairs still do', () => {
  const ev = (country: unknown, region: unknown, locality = 'London') => ld({ '@type': 'Event', name: 'Embedd office opening', startDate: '2026-10-19', organizer: { name: 'Embedd' }, location: { '@type': 'Place', name: `Embedd ${locality} office`, address: { '@type': 'PostalAddress', addressLocality: locality, addressCountry: country, addressRegion: region } } })
  const claims: [string, string[]][] = [['Embedd opened a new office in London, UK', ['London, UK']], ['Embedd opened a new office in London', []], ['Embedd opened a new office in London, Ontario', ['London, Ontario, Canada']], ['Embedd opened a new office in London, Canada', ['London, Canada']], ['Embedd opened a new office in London', ['London']]]
  const contradictory: [unknown, unknown][] = [['Canada', 'England'], ['CA', 'England'], ['CANADA', 'ENGLAND'], ['US', 'Ontario'], ['United States', 'ON'], ['UK', 'NY'], ['GB', 'New York'], ['CA', 'Scotland'], ['Canada', 'Scotland'], ['GB', 'Ontario'], ['FR', 'England'], [{ name: 'Canada' }, 'england']]
  for (const [country, region] of contradictory) for (const [claim, where] of claims) assert.equal(resolveStructuredDate([ev(country, region)], 'Embedd', claim, where), null, `${JSON.stringify([country, region])} | ${claim} | ${JSON.stringify(where)}`)
  // agreeing pairs date their own claims
  assert.deepEqual(resolveStructuredDate([ev('GB', 'England')], 'Embedd', 'Embedd opened a new office in London, UK', ['London, UK']), { date: '2026-10-19', kind: 'Event' })
  assert.deepEqual(resolveStructuredDate([ev('Canada', 'ON')], 'Embedd', 'Embedd opened a new office in London, Ontario', ['London, Ontario, Canada']), { date: '2026-10-19', kind: 'Event' })
  assert.deepEqual(resolveStructuredDate([ev('US', 'NY', 'New York')], 'Embedd', 'Embedd opened a new office in New York, NY', ['New York, NY, USA']), { date: '2026-10-19', kind: 'Event' })
  for (const [country, region] of [['GB', 'England'], ['UK', 'england'], ['United Kingdom', 'ENGLAND'], ['CA', 'Ontario'], ['Canada', 'ON'], ['US', 'NY']] as const) assert.notEqual(country, null)
})
test('an event whose address list implies disjoint countries (a region list across two countries) dates nothing', () => {
  const two = ld({ '@type': 'Event', name: 'Embedd office opening', startDate: '2026-10-19', organizer: { name: 'Embedd' }, location: [{ '@type': 'Place', name: 'Embedd London office', address: { addressLocality: 'London', addressRegion: 'England', addressCountry: 'GB' } }, { '@type': 'Place', name: 'Embedd London office', address: { addressLocality: 'London', addressRegion: 'Ontario', addressCountry: 'CA' } }] })
  assert.equal(resolveStructuredDate([two], 'Embedd', 'Embedd opened a new office in London, UK', ['London, UK']), null)
  const regionsOnly = ld({ '@type': 'Event', name: 'Embedd office opening', startDate: '2026-10-19', organizer: { name: 'Embedd' }, location: { '@type': 'Place', name: 'Embedd London office', address: [{ addressLocality: 'London', addressRegion: 'England' }, { addressLocality: 'London', addressRegion: 'Ontario' }] } })
  assert.equal(resolveStructuredDate([regionsOnly], 'Embedd', 'Embedd opened a new office in London, UK', ['London, UK']), null)
})
test('the same check on the claim / request side: a request that contradicts itself ("London, Ontario, UK", "New York, NY, Canada", "London, England, Canada") dates nothing - even for an event that agrees with one half', () => {
  const ev = (country: string, region: string, locality = 'London') => ld({ '@type': 'Event', name: 'Embedd office opening', startDate: '2026-10-19', organizer: { name: 'Embedd' }, location: { '@type': 'Place', name: `Embedd ${locality} office`, address: { '@type': 'PostalAddress', addressLocality: locality, addressCountry: country, addressRegion: region } } })
  for (const req of ['London, Ontario, UK', 'LONDON, ONTARIO, UNITED KINGDOM', 'London, England, Canada', 'London, Scotland, Canada']) {
    for (const e of [ev('GB', 'England'), ev('CA', 'Ontario')]) assert.equal(resolveStructuredDate([e], 'Embedd', 'Embedd opened a new office in London', [req]), null, `${req}`)
  }
  assert.equal(resolveStructuredDate([ev('US', 'NY', 'New York')], 'Embedd', 'Embedd opened a new office in New York', ['New York, NY, Canada']), null)
  assert.equal(resolveStructuredDate([ev('GB', 'England')], 'Embedd', 'Embedd opened a new office in London, England', ['London, Ontario']), null, 'a request region from another country than the claim\'s own')
  // consistent requests still work
  assert.deepEqual(resolveStructuredDate([ev('GB', 'England')], 'Embedd', 'Embedd opened a new office in London', ['London, England, UK']), { date: '2026-10-19', kind: 'Event' })
})
test('FULL RUN: an internally contradictory event (Canada + England) leaves the London, UK claim undated and held', async () => {
  const ev = (country: string, region: string, startDate: string) => ld({ '@context': 'https://schema.org', '@type': 'Event', name: 'Embedd office opening', startDate, organizer: { '@type': 'Organization', name: 'Embedd' }, location: { '@type': 'Place', name: 'Embedd London office', address: { '@type': 'PostalAddress', addressLocality: 'London', addressCountry: country, addressRegion: region } } })
  const claim = 'Embedd opened a new office in London, UK for its growing engineering team'
  for (const [c, r] of [['Canada', 'England'], ['US', 'Ontario'], ['CA', 'Scotland']] as const) {
    const held = await row(fx([ev(c, r, daysAgo(9))], { quote: claim }))
    assert.equal(held.r.event_date, null, `${c}+${r}`); assert.equal(held.r.review_reason, 'outside_window_undated'); assert.equal(held.r.timing_note, null)
  }
  const ok = await row(fx([ev('GB', 'England', daysAgo(9))], { quote: claim }))
  assert.equal(ok.r.event_date, daysAgo(9)); assert.equal(ok.r.review_reason, null)
})
