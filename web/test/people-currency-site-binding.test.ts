// #781 (audit 9379b162, 2026-11-06 19:29Z): a recent sitecrawl person row is "verified current, first-party page"
// only when the page is on the lead's ESTABLISHED website identity - the same identityOf rule the card's identity line
// and the contact route use (own-domain basis, or the user's own currently-bound website review). Before this fix
// contactCurrency read only connector/kind/retrieved_at/roleHeld, so a recent "Pat Example, Sales Director" row from
// https://unconfirmed-namesake.example/team was verified current with no domain row, or with only a name_probe row.
// Every company, person and site here is SYNTHETIC; nothing is fetched.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { contactCurrency, currencyText, splitByCurrency } from '../lib/people/currency.ts'
import { contactsFromEnrichments, peopleSourceText } from '../lib/people/rank.ts'
import { identityOf } from '../lib/scan/opportunity.ts'
import { domainReviewFor, REVIEW_PREFIX } from '../lib/outreach/domain-review.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, addEnrichment } from '../lib/connectors/store.ts'
import { bestPeople } from '../lib/people/best-person.ts'
import { sqliteDb } from '../lib/db/client.ts'

const NOW = Date.UTC(2026, 10, 6, 12)
const RECENT = Math.floor(NOW / 1000) - 3 * 86_400
const SITE = 'unconfirmed-namesake.example'
const PAT = { kind: 'person', value: 'Pat Example, Sales Director', label: 'listed with this title on this company page, not verified as current staff', source_url: `https://${SITE}/team`, connector: 'sitecrawl', retrieved_at: RECENT }
const domainRow = (site: string, token: string, page = 'https://news.example/aurora') => ({ kind: 'domain', value: `${site}|${token}`, label: `domain-basis-v1:${token}`, source_url: page, connector: 'sitecrawl' })
const emailRow = (addr: string, site = SITE) => ({ kind: 'email', value: addr, label: null, source_url: `https://${site}/contact`, connector: 'sitecrawl', retrieved_at: RECENT })
const LEAD = { id: 'lead1', contact: null }
type Row = { kind: string; value: string; label: string | null; source_url: string; connector: string; retrieved_at?: number }
const pat = (rows: Row[]) => contactsFromEnrichments([PAT, ...rows], 'Sales Director', NOW, identityOf(LEAD, [PAT, ...rows])).find(p => p.name === 'Pat Example')!
const reviewOf = (rows: Row[]): Row => {
  const d = domainReviewFor(LEAD, rows)
  return { kind: 'domain_review', value: d.domain!, label: REVIEW_PREFIX + d.binding, source_url: '', connector: 'user' }
}

test('the audited reproduction: no domain row -> search-result-only, with the reason', () => {
  const p = pat([])
  assert.equal(p.currency, 'search_only')
  assert.match(p.verified!.reason!, /not recorded as the company's own/)
  assert.equal(currencyText(p.verified!, p.connector).startsWith('search result only, not verified as current: '), true)
})

test('only a name_probe or link-text site, without a current user review -> search-result-only', () => {
  for (const token of ['name_probe', 'evidence_link_text', 'evidence_link_domain_label']) {
    const p = pat([domainRow(SITE, token)])
    assert.equal(p.currency, 'search_only', token)
    assert.match(p.verified!.reason!, /not confirmed as the company's own website/, token)
  }
})

test('conflicting recorded sites -> search-result-only', () => {
  const p = pat([domainRow(SITE, 'evidence_own_domain'), domainRow('other-aurora.example', 'name_probe')])
  assert.equal(p.currency, 'search_only')
  assert.match(p.verified!.reason!, /several websites recorded/)
})

test('control: own-domain basis, person read on that site -> verified current, first-party page', () => {
  const p = pat([domainRow(SITE, 'evidence_own_domain', `https://${SITE}/news`)])
  assert.equal(p.currency, 'verified_current')
  assert.deepEqual(p.verified, { currency: 'verified_current', basis: 'first_party_page', dated: new Date(RECENT * 1000).toISOString().slice(0, 10) })
  assert.equal(p.verified!.reason, undefined)
})

test('own-domain site, but the person was read on some other host -> search-result-only', () => {
  const rows = [domainRow('aurora.example', 'evidence_own_domain', 'https://aurora.example/news')]
  const p = pat(rows)
  assert.equal(p.currency, 'search_only')
  assert.match(p.verified!.reason!, /not on the company's identified website aurora\.example/)
  // a subdomain of the identified site is the site
  const sub = { ...PAT, source_url: 'https://team.aurora.example/people' }
  const q = contactsFromEnrichments([sub, ...rows], 'Sales Director', NOW, identityOf(LEAD, [sub, ...rows]))[0]
  assert.equal(q.currency, 'verified_current')
})

test('a correctly bound user confirmation of a name_probe site preserves first-party; a stale binding does not', () => {
  const base = [domainRow(SITE, 'name_probe'), emailRow(`sales@${SITE}`)]
  const confirmed = [...base, reviewOf(base)]
  assert.equal(identityOf(LEAD, confirmed)?.state, 'user_confirmed')
  assert.equal(pat(confirmed).currency, 'verified_current', 'the user checked this site is theirs')
  // the crawl later records another address: the old review no longer matches what the user was shown
  const stale = [...confirmed, emailRow(`hello@${SITE}`)]
  assert.equal(identityOf(LEAD, stale)?.state, 'unconfirmed')
  const p = pat(stale)
  assert.equal(p.currency, 'search_only', 'a stale review binding does not verify')
  assert.match(p.verified!.reason!, /not confirmed/)
})

test('fail closed without a site argument; the date predicate still applies on an established site', () => {
  assert.equal(contactCurrency(PAT, true, NOW).currency, 'search_only', 'no identity passed: never first-party')
  const own = { state: 'fact' as const, site: SITE, text: `${SITE}: the cited page is on this site` }
  assert.equal(contactCurrency(PAT, true, NOW, own).currency, 'verified_current')
  assert.equal(contactCurrency({ ...PAT, retrieved_at: Math.floor(NOW / 1000) - 181 * 86_400 }, true, NOW, own).currency, 'search_only', 'outside 180 days')
  assert.equal(contactCurrency({ ...PAT, retrieved_at: Math.floor(NOW / 1000) + 2 * 86_400 }, true, NOW, own).currency, 'search_only', 'future reading')
  assert.equal(contactCurrency(PAT, false, NOW, own).currency, 'search_only', 'role not held')
  // a title-less row on an unestablished site still carries the reason, so the source label never says "the company website"
  const untitled = contactCurrency(PAT, false, NOW, null)
  assert.ok(untitled.reason)
})

test('UI contract: unestablished rows sit under "Search result only" with the reason, not as "the company website"', () => {
  const people = contactsFromEnrichments([PAT, domainRow(SITE, 'name_probe')], 'Sales Director', NOW, identityOf(LEAD, [PAT, domainRow(SITE, 'name_probe')]))
  const { verified, searchOnly } = splitByCurrency(people)
  assert.deepEqual(verified.map(p => p.name), [])
  assert.deepEqual(searchOnly.map(p => p.name), ['Pat Example'])
  assert.doesNotMatch(peopleSourceText(searchOnly[0]), /^the company website/)
  const ok = contactsFromEnrichments([PAT, domainRow(SITE, 'evidence_own_domain', `https://${SITE}/x`)], 'Sales Director', NOW, identityOf(LEAD, [PAT, domainRow(SITE, 'evidence_own_domain', `https://${SITE}/x`)]))[0]
  assert.match(peopleSourceText(ok), /^the company website/)
  // the leads page passes the lead's identity and shows the reason
  const page = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  assert.ok(page.includes('identityOf({ id: l.id, contact: l.contact }, l.enrichments)'), 'the Right people block passes the lead identity')
  assert.ok(page.includes('peopleSourceText(p)'), 'the source label comes from peopleSourceText')
  assert.ok(page.includes("p.currency === 'verified_current' || p.verified.reason"), 'a held row shows its reason')
})

test('export contract: Best Person found-via never claims first-party verification on an unestablished site', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ who: ['Sales Director'] }), jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, score) VALUES ('lead1', ?, '', 'Aurora', ?, 'x', 'https://news.example/aurora', 50)").run(jobId, SITE)
  const add = (r: Row) => addEnrichment(db, 'u1', 'lead1', { connector: r.connector, kind: r.kind, value: r.value, label: r.label, confidence: 60, source_url: r.source_url, source_date: '2026-11-03', retrieved_at: r.retrieved_at ?? RECENT })
  add(PAT); add(domainRow(SITE, 'name_probe'))
  const held = (await bestPeople(sqliteDb(db), 'u1', [{ lead_id: 'lead1', job_id: jobId }])).get('lead1')!
  assert.equal(held.best_person, 'Pat Example')
  assert.doesNotMatch(held.best_person_found_via, /verified current: named on the company's own website/)
  assert.match(held.best_person_found_via, /search result only, not verified as current: .*not confirmed/)
  // control: an own-domain site verifies through the export path too
  db.prepare("DELETE FROM lead_enrichments WHERE kind = 'domain'").run()
  add(domainRow(SITE, 'evidence_own_domain', `https://${SITE}/news`))
  const okRow = (await bestPeople(sqliteDb(db), 'u1', [{ lead_id: 'lead1', job_id: jobId }])).get('lead1')!
  assert.match(okRow.best_person_found_via, /verified current: named on the company's own website, read 2026-11-03/)
})
