import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { companyKey, dedupKey, verifyEvidence, type Candidate } from '../lib/scan/evidence.ts'
import { htmlToText, isPublicIp, safeFetchPage } from '../lib/scan/fetch-page.ts'
import { createJob, listLeads, migrateScan } from '../lib/scan/store.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { claimKeyedJob, runJob, verifyLeads } from '../lib/scan/runner.ts'
import { randomBytes } from 'node:crypto'

const NOW = new Date('2026-10-20T12:00:00Z')
const QUOTE = 'Northside Builders opened a second yard and is hiring five roofers this month'
const cand = (o: Partial<Candidate> = {}): Candidate => ({ name: '', company: 'Northside Builders Inc.', contact: null, signal: 'Expanding', source_url: 'https://northsidebuilders.example/a', score: 70, excerpt: QUOTE, event_date: '2026-10-01', ...o })
const page = (text: string, title = '') => ({ text, title, retrievedAt: 1_800_000_000 })
const good = page(`October 2026 local news. ${QUOTE}. Call 416-555-0199 or email jobs@northside.example.`)

test('good evidence passes with high confidence and a verified date', () => {
  const v = verifyEvidence(cand(), good, NOW)
  assert.equal(v.ok, true)
  if (v.ok) { assert.equal(v.dateStatus, 'verified'); assert.ok(v.confidence >= 80) }
})

test('quote that is not on the page is rejected (model invented or paraphrased it)', () => {
  const v = verifyEvidence(cand({ excerpt: 'Northside Builders just raised a huge funding round last week' }), good, NOW)
  assert.deepEqual(v, { ok: false, reason: 'excerpt_not_on_page' })
  assert.deepEqual(verifyEvidence(cand({ excerpt: 'too short' }), good, NOW), { ok: false, reason: 'no_excerpt' })
})

test('wrong company: quote is real but about someone else', () => {
  const p = page('Southside Roofing opened a second yard and is hiring five roofers this month. Northside Builders is a rival firm.')
  const v = verifyEvidence(cand({ excerpt: 'Southside Roofing opened a second yard and is hiring five roofers this month' }), p, NOW)
  assert.deepEqual(v, { ok: false, reason: 'entity_mismatch' })
  // company named only far from the quote and not in the title is not enough
  const far = page(`Northside Builders. ${'filler word '.repeat(200)} Acme Corp opened a second yard and is hiring five roofers this month`)
  assert.deepEqual(verifyEvidence(cand({ excerpt: 'Acme Corp opened a second yard and is hiring five roofers this month' }), far, NOW), { ok: false, reason: 'entity_mismatch' })
})

test('old news: claimed date too old, or page shows an older year than claimed', () => {
  assert.deepEqual(verifyEvidence(cand({ event_date: '2024-03-01' }), good, NOW), { ok: false, reason: 'stale' })
  const old = page(`Published March 2019. ${QUOTE}.`)
  assert.deepEqual(verifyEvidence(cand({ event_date: '2026-10-01' }), old, NOW), { ok: false, reason: 'date_conflict' })
  assert.deepEqual(verifyEvidence(cand({ event_date: '2027-05-01' }), good, NOW), { ok: false, reason: 'future_date' })
  assert.deepEqual(verifyEvidence(cand({ event_date: 'last Tuesday' }), good, NOW), { ok: false, reason: 'bad_date' })
})

test('undated or unverified dates lower confidence but can still pass; contacts only if on the page', () => {
  const undated = verifyEvidence(cand({ event_date: null }), page(`${QUOTE}.`), NOW)
  assert.equal(undated.ok, true)
  if (undated.ok) { assert.equal(undated.dateStatus, 'undated'); assert.equal(undated.confidence, 55) }
  const withContact = verifyEvidence(cand({ contact: 'jobs@northside.example' }), good, NOW)
  const fakeContact = verifyEvidence(cand({ contact: 'ceo@northside.example' }), good, NOW)
  assert.equal(withContact.ok && withContact.contact, 'jobs@northside.example')
  assert.equal(fakeContact.ok && fakeContact.contact, null)
  const phone = verifyEvidence(cand({ contact: '(416) 555-0199' }), good, NOW)
  assert.equal(phone.ok && phone.contact, '(416) 555-0199')
})

test('company key ignores legal suffixes and case; dedup picks the best lead per company', async () => {
  assert.equal(companyKey('The Northside Builders, Inc.'), 'northside builders')
  assert.equal(dedupKey({ company: 'NORTHSIDE BUILDERS LTD', name: 'x' }), dedupKey({ company: 'Northside Builders', name: 'y' }))
  const fetchPage = async (u: string) => (u.endsWith('/b') ? page(`Posted 2026. ${QUOTE}. Email jobs@northside.example`) : page(`${QUOTE}.`))
  const { leads, dropped } = await verifyLeads([
    cand({ source_url: 'https://northsidebuilders.example/a', event_date: null }),
    cand({ source_url: 'https://northsidebuilders.example/b', company: 'Northside Builders Ltd', contact: 'jobs@northside.example' }),
    cand({ source_url: 'https://northsidebuilders.example/c', company: 'Someone Else', excerpt: 'this quote does not exist anywhere on the page at all' }),
  ], fetchPage, NOW)
  assert.equal(leads.length, 1)
  assert.equal(leads[0].source_url, 'https://northsidebuilders.example/b')
  assert.equal(dropped.duplicate, 1)
  assert.equal(dropped.excerpt_not_on_page, 1)
})

test('unreachable pages are dropped', async () => {
  const { leads, dropped } = await verifyLeads([cand()], async () => null, NOW)
  assert.equal(leads.length, 0)
  assert.equal(dropped.page_unreachable, 1)
})

test('end to end: only verified leads are stored with evidence, per tenant; counts recorded', async () => {
  const master = randomBytes(32)
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-' + 'A'.repeat(40), master)
  const id = createJob(db, 'A', { business_name: 'Acme', industry: 'roofing', location: 'Toronto' })
  const text = JSON.stringify([cand({ event_date: '2026-10-05' }), cand({ source_url: 'https://northsidebuilders.example/zzz', excerpt: 'Fabricated quote that never appeared on any page anywhere', company: 'Other Co' })])
  const providers = { anthropic: { research: async () => ({ text, citedUrls: ['https://northsidebuilders.example/a', 'https://northsidebuilders.example/zzz'] }) }, openai: { research: async () => ({ text: '[]', citedUrls: [] }) } }
  await runJob(db, claimKeyedJob(db)!, { providers, master, now: NOW, fetchPage: async () => good })
  const rows = listLeads(db, 'A', id) as { evidence_excerpt: string; confidence: number; event_date: string }[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].evidence_excerpt, QUOTE)
  assert.ok(rows[0].confidence >= 80)
  const j = db.prepare('SELECT candidates, verified FROM scan_jobs WHERE id = ?').get(id) as { candidates: number; verified: number }
  assert.deepEqual({ ...j }, { candidates: 2, verified: 1 })
  assert.equal(listLeads(db, 'B', id).length, 0)
})

test('end to end: an unconfirmable quote is stored on the needs-review row, not thrown away', async () => {
  const master = randomBytes(32)
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-' + 'A'.repeat(40), master)
  const id = createJob(db, 'A', { business_name: 'Acme', industry: 'roofing', location: 'Toronto' })
  const paraphrase = 'a summary sentence the model wrote that never appears on the page'
  const text = JSON.stringify([cand({ excerpt: paraphrase, event_date: null })])
  const providers = { anthropic: { research: async () => ({ text, citedUrls: ['https://northsidebuilders.example/a'] }) }, openai: { research: async () => ({ text: '[]', citedUrls: [] }) } }
  await runJob(db, claimKeyedJob(db)!, { providers, master, now: NOW, fetchPage: async () => good })
  const rows = listLeads(db, 'A', id) as { evidence_excerpt: string | null; review_reason: string | null }[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].review_reason, 'quote_unconfirmed')
  assert.equal(rows[0].evidence_excerpt, paraphrase)
  const j = db.prepare('SELECT candidates, verified, needs_review FROM scan_jobs WHERE id = ?').get(id) as { candidates: number; verified: number; needs_review: number }
  assert.deepEqual({ ...j }, { candidates: 1, verified: 0, needs_review: 1 })
})

test('SSRF guard: private, loopback, metadata and non-https URLs are never fetched', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(isPublicIp(ip), false, ip)
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(isPublicIp(ip), true, ip)
  for (const u of ['http://example.com/', 'https://127.0.0.1/', 'https://[::1]/', 'https://169.254.169.254/latest/meta-data', 'https://localhost/', 'https://example.com:8443/', 'https://user:pw@example.com/', 'file:///etc/passwd', 'not a url'])
    assert.equal(await safeFetchPage(u), null, u)
})

test('htmlToText drops scripts and styles and decodes entities', () => {
  const r = htmlToText('<html><head><title>Acme &amp; Co</title><style>x{}</style></head><body><script>evil()</script><p>Hello&nbsp;<b>world</b> &#38; more</p></body></html>')
  assert.equal(r.title, 'Acme & Co')
  assert.equal(r.text, 'Acme & Co Hello world & more')
})

test('per-source cap: a single page yields at most 3 verified leads, strongest kept', async () => {
  const companies = ['Acme Alpha', 'Acme Beta', 'Acme Gamma', 'Acme Delta', 'Acme Epsilon']
  const quote = (c: string) => `${c} announced a second depot and is hiring twelve drivers this spring`
  const bigPage = async () => page(`Roundup 2026. ${companies.map(quote).join('. ')}.`)
  const { leads, dropped } = await verifyLeads(
    companies.map((c, i) => cand({ company: c, source_url: 'https://roundup.example/list', excerpt: quote(c), score: 90 - i })),
    bigPage, NOW,
  )
  assert.equal(leads.length, 3)
  assert.equal(dropped['source_cap'], 2)
  assert.deepEqual(leads.map(l => l.company).sort(), ['Acme Alpha', 'Acme Beta', 'Acme Gamma'])
})

// --- supportedEvidenceWindow: narrow supported-signal extraction (adversarial matrix) ---
const OHM_TEXT = 'Careers at Ohm. Help us reimagine how physical products are engineered. At Ohm we work on problems at the intersection of engineering, science, and artificial intelligence. Founding Account Executive San Francisco, CA · Hybrid Apply Founding Account Executive, EMEA United Kingdom · Remote Apply Chief of Staff San Francisco, CA / Remote (London, UK) Apply Forward Deployed Engineer, Battery Engineering San Francisco, CA · Hybrid Apply'
const OHM_SIGNAL = 'Ohm is actively hiring for multiple senior go-to-market roles including two Founding Account Executive positions and a Chief of Staff.'
const OHM_CLAIM = { company: 'Ohm', signal: OHM_SIGNAL, excerpt: 'Ohm is actively hiring for multiple senior go-to-market roles' }

test('supportedEvidenceWindow: Ohm-shaped paraphrase attaches the verbatim roles window', async () => {
  const { supportedEvidenceWindow } = await import('../lib/scan/evidence.ts')
  const win = supportedEvidenceWindow(OHM_CLAIM, { text: OHM_TEXT, title: 'Careers | Ohm', url: 'https://ohm.ai/careers' })
  assert.ok(win, 'a supporting window exists')
  assert.ok(OHM_TEXT.replace(/\s+/g, ' ').includes(win!), 'the window is verbatim page text')
  assert.ok(win!.includes('Founding Account Executive') && win!.includes('Chief of Staff'))
  // ...and the unchanged verifier accepts it against the same page
  const v = verifyEvidence(cand({ company: 'Ohm', excerpt: win!, event_date: null, contact: null }), page(OHM_TEXT, 'Careers | Ohm'), NOW)
  assert.equal(v.ok, true)
})

test('supportedEvidenceWindow: analyst gloss, negation, closed vacancies, wrong entity, navigation, partial counts, analysis prose all refuse to attach', async () => {
  const { supportedEvidenceWindow } = await import('../lib/scan/evidence.ts')
  const hiring = { company: 'Acme', signal: 'Acme is hiring two account executives.', excerpt: 'Acme is hiring two account executives right now' }
  // analyst gloss anywhere in the claim routes to review - unsupported text is never trimmed silently
  assert.equal(supportedEvidenceWindow({ ...OHM_CLAIM, signal: OHM_SIGNAL + ' Indicating significant expansion and investment in sales capacity.' }, { text: OHM_TEXT, title: 'Careers | Ohm', url: 'https://ohm.ai/careers' }), null)
  // window-side negation
  assert.equal(supportedEvidenceWindow(hiring, { text: 'Acme news. We are not currently hiring for account executive roles this year. More text here.', title: 'Acme', url: 'https://acme.com/careers' }), null)
  // closed vacancy
  assert.equal(supportedEvidenceWindow(hiring, { text: 'Acme careers. This position has been filled: Account Executive, Toronto. More text here.', title: 'Acme careers', url: 'https://acme.com/careers' }), null)
  // wrong entity: page about a rival, company named nowhere near the window
  assert.equal(supportedEvidenceWindow({ company: 'Northside Builders', signal: 'Northside Builders is hiring two account executives.', excerpt: 'hiring two account executives now' }, { text: 'Southside Roofing is hiring an Account Executive and another Account Executive for its Toronto office. ' + 'filler word '.repeat(40), title: 'Southside Roofing careers', url: 'https://northsidebuilders.com/careers' }), null)
  // generic navigation only
  assert.equal(supportedEvidenceWindow(hiring, { text: 'Careers Jobs Apply Home About Contact Privacy Terms Acme Account Executive Account Executive', title: 'Acme', url: 'https://acme.com/careers' }), null)
  // partial role counts: claim wants two FAE + Chief of Staff, page lists one FAE only
  assert.equal(supportedEvidenceWindow(OHM_CLAIM, { text: 'At Ohm we build tools. Founding Account Executive San Francisco, CA · Hybrid Apply Forward Deployed Engineer San Francisco · Hybrid Apply', title: 'Careers | Ohm', url: 'https://ohm.ai/careers' }), null)
  // unsupported expansion/investment analysis prose: no concrete hiring event claimed
  assert.equal(supportedEvidenceWindow({ company: 'Ohm', signal: 'Ohm shows significant expansion and investment in sales capacity.', excerpt: 'significant expansion and investment in sales capacity' }, { text: OHM_TEXT, title: 'Careers | Ohm', url: 'https://ohm.ai/careers' }), null)
  // quantity mismatch: claim says five, window lists one
  assert.equal(supportedEvidenceWindow({ company: 'Acme', signal: 'Acme is hiring five account executives.', excerpt: 'hiring five account executives' }, { text: 'Acme careers. Account Executive Toronto · Apply now. More text here for length.', title: 'Acme', url: 'https://acme.com/careers' }), null)
  // vague hiring claim with no concrete role
  assert.equal(supportedEvidenceWindow({ company: 'Acme', signal: 'Acme is hiring for its team.', excerpt: 'Acme is hiring right now' }, { text: 'Acme careers. We are hiring. Apply now and join the team building great things.', title: 'Acme', url: 'https://acme.com/careers' }), null)
})

test('supportedEvidenceWindow: adversarial battery ADV1-ADV8 from independent review all refuse to attach', async () => {
  const { supportedEvidenceWindow } = await import('../lib/scan/evidence.ts')
  // ADV1 claim-side negation: "not hiring" claim must not attach an active-hiring window
  assert.equal(supportedEvidenceWindow({ company: 'Acme', signal: 'Acme is not currently hiring engineers.', excerpt: 'Acme is not currently hiring engineers at all' }, { text: 'Acme careers. We are hiring engineers in Toronto. Apply now and join the team building great things.', title: 'Acme careers', url: 'https://acme.com/careers' }), null)
  // ADV2 rival funding with lead entity only in title - funding never attaches
  assert.equal(supportedEvidenceWindow({ company: 'Acme', signal: 'Acme raised $10M in Series A funding.', excerpt: 'Acme raised a huge Series A round recently' }, { text: 'Acme news roundup. Rival Robotics raised $10M in Series A funding led by Big Capital to expand its team. The market reacts.', title: 'Acme news', url: 'https://acme.com/careers' }), null)
  // ADV3 generic "series" token is not funding evidence
  assert.equal(supportedEvidenceWindow({ company: 'Acme', signal: 'Acme raised Series A funding.', excerpt: 'Acme raised a big new Series A round' }, { text: 'Acme blog. Join us for a series of community events this summer in the park. Bring your friends and family along.', title: 'Acme blog', url: 'https://acme.com/careers' }), null)
  // ADV4 wrong amount: claim $50M Series B, evidence $10M Series A - funding never attaches
  assert.equal(supportedEvidenceWindow({ company: 'Acme', signal: 'Acme raised $50M in Series B funding.', excerpt: 'Acme raised a massive $50M Series B round' }, { text: 'Acme news. Acme raised $10M in Series A funding led by Example Capital to grow its Toronto team. The company declined to comment further.', title: 'Acme news', url: 'https://acme.com/careers' }), null)
  // ADV5 a repeated identical posting is ONE opening, not two
  assert.equal(supportedEvidenceWindow({ company: 'Acme', signal: 'Acme is hiring two account executives.', excerpt: 'Acme is hiring two account executives right now' }, { text: 'Acme careers. Account Executive Toronto Apply now for this opening. Account Executive Toronto Apply now for this opening. Footer text here.', title: 'Acme careers', url: 'https://acme.com/careers' }), null)
  // ADV6 past tense: "hired last year" against a present opening
  assert.equal(supportedEvidenceWindow({ company: 'Acme', signal: 'Acme hired engineers last year.', excerpt: 'Acme hired engineers last year for the platform team' }, { text: 'Acme careers. We are hiring engineers in Toronto. Apply now and join the team building great things.', title: 'Acme careers', url: 'https://acme.com/careers' }), null)
  // ADV7 entity 300+ chars away, window about a rival
  const pad = 'filler words here. '.repeat(15)
  assert.equal(supportedEvidenceWindow({ company: 'Acme', signal: 'Acme is hiring two account executives.', excerpt: 'Acme is hiring two account executives right now' }, { text: `News daily. ${pad} Acme was mentioned in passing. ${pad} Rival Robotics is hiring an account executive and an account executive for its Toronto office.`, title: 'News daily', url: 'https://acme.com/careers' }), null)
  // ADV8 stale 2019 funding, undated claim - funding never attaches
  assert.equal(supportedEvidenceWindow({ company: 'Acme', signal: 'Acme raised seed funding.', excerpt: 'Acme raised a fresh seed round recently' }, { text: 'Acme news archive. Acme raised $4M in seed funding in 2019 led by Old Capital. The company has been quiet since then.', title: 'Acme news', url: 'https://acme.com/careers' }), null)
})

test('supportedEvidenceWindow: second adversarial round - rival subject, denies-hiring, gloss, future tense, not-planning, non-first-party all refuse to attach', async () => {
  const { supportedEvidenceWindow } = await import('../lib/scan/evidence.ts')
  const twoAe = { company: 'Acme', signal: 'Acme is hiring two account executives.', excerpt: 'Acme is hiring two account executives' }
  const acmeTwoListings = 'Acme careers. Account Executive Toronto · Apply now. Account Executive Montreal · Apply now. More text here.'
  // control: the plain claim attaches against the company's own careers page
  assert.ok(supportedEvidenceWindow(twoAe, { text: acmeTwoListings, title: 'Acme careers', url: 'https://acme.com/careers' }), 'control attaches')
  // rival hiring subject near the company name inside the window
  const rivalNear = 'Acme rival Rival Robotics is hiring an Account Executive in Toronto. Rival Robotics is hiring an Account Executive in Montreal.'
  assert.equal(supportedEvidenceWindow(twoAe, { text: rivalNear, title: 'Acme', url: 'https://acme.com/careers' }), null)
  // rival subject with the company named only in the page title
  const rivalTitle = 'Rival Robotics is hiring an Account Executive in Toronto. Rival Robotics is hiring an Account Executive in Montreal. filler words here. '
  assert.equal(supportedEvidenceWindow(twoAe, { text: rivalTitle, title: 'Acme careers', url: 'https://acme.com/careers' }), null)
  // claim-side denial: "denies hiring" is not an affirmative hiring assertion
  assert.equal(supportedEvidenceWindow({ company: 'Acme', signal: 'Acme denies hiring engineers.', excerpt: 'Acme denies hiring engineers' }, { text: acmeTwoListings, title: 'Acme careers', url: 'https://acme.com/careers' }), null)
  // window-side denial: "not planning to hire" must not verify an active-hiring claim
  const notPlanning = 'Acme update. We are not planning to hire this year. Account Executive Toronto · Apply. Account Executive Montreal · Apply.'
  assert.equal(supportedEvidenceWindow(twoAe, { text: notPlanning, title: 'Acme', url: 'https://acme.com/careers' }), null)
  // analyst gloss: "implying" and "a sign of" are unsupported additions, never trimmed silently
  assert.equal(supportedEvidenceWindow({ ...twoAe, signal: 'Acme is hiring two account executives, implying rapid growth.', excerpt: twoAe.excerpt }, { text: acmeTwoListings, title: 'Acme careers', url: 'https://acme.com/careers' }), null)
  assert.equal(supportedEvidenceWindow({ ...twoAe, signal: 'Acme is hiring two account executives, a sign of expansion.', excerpt: twoAe.excerpt }, { text: acmeTwoListings, title: 'Acme careers', url: 'https://acme.com/careers' }), null)
  // future tense: a next-quarter claim must not verify against current openings
  assert.equal(supportedEvidenceWindow({ company: 'Acme', signal: 'Acme is hiring two account executives next quarter.', excerpt: 'Acme is hiring two account executives next quarter' }, { text: acmeTwoListings, title: 'Acme careers', url: 'https://acme.com/careers' }), null)
  assert.equal(supportedEvidenceWindow({ company: 'Acme', signal: 'Acme will hire two account executives.', excerpt: 'Acme will hire two account executives' }, { text: acmeTwoListings, title: 'Acme careers', url: 'https://acme.com/careers' }), null)
  // repair is first-party only: the same clean claim against editorial text stays on review
  assert.equal(supportedEvidenceWindow(OHM_CLAIM, { text: OHM_TEXT, title: 'Careers | Ohm', url: 'https://techcrunch.com/2026/10/22/ohm-hiring' }), null)
  // ...and against an aggregator jobs board
  assert.equal(supportedEvidenceWindow(OHM_CLAIM, { text: OHM_TEXT, title: 'Careers | Ohm', url: 'https://wellfound.com/jobs/ohm' }), null)
})

test('supportedEvidenceWindow: already-verbatim excerpt is a no-op', async () => {
  const { supportedEvidenceWindow } = await import('../lib/scan/evidence.ts')
  assert.equal(supportedEvidenceWindow({ company: 'Acme', signal: 'Hiring', excerpt: QUOTE }, { text: `News. ${QUOTE}.`, title: 'Acme', url: 'https://acme.com/careers' }), null)
})
