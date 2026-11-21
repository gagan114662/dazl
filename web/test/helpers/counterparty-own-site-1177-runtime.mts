// #1177: a customer-mention row (counterparty_signal) whose OWN website is settled gets Find work email and Find contact,
// through the real route handlers, the real stores, the real crawler and the real lookup. Only the outside world is stubbed:
// the provider answer (fetch) and the https transport (mapped to a loopback fixture server).
//
// Real prod wording: the cited page is a vendor's growth post that names its customers. LINEAR_TEXT is the title and opening
// text of that real page (linear.app) as dazl fetched it (the same text as test/counterparty.test.ts); the lead's company is one of
// the customers it names. The company's own website and its people are anonymised (.test hosts, invented person).
//
// What the crawler records today: it marks a website evidence_own_domain only for the cited page's OWN host
// (sitecrawl.ts findCompanySitesWithBasis), which on a customer mention is the vendor's. The last test runs the real crawler on the
// real vendor wording and shows the customer's site comes out linked-only, so the row stays refused. The settled-own-site rows in the
// first two tests are seeded directly: the state the rule unlocks, which no crawl writes for such a row today.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { installFixtureTransport } from './fixture-company-transport.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { createJob } from '../../lib/scan/store.ts'
import { saveCredential } from '../../lib/connectors/store.ts'
import { confirmLeadReview } from '../../lib/scan/review-confirm.ts'
import { companySearchEligible } from '../../lib/scan/find-contact-eligible.ts'
import { workEmailLeadEligible } from '../../lib/people/work-email-eligible.ts'
import { domainReviewFor, REVIEW_PREFIX } from '../../lib/outreach/domain-review.ts'
import { crawlJob } from '../../lib/connectors/sitecrawl.ts'
import { reviewLaneWorkEmailTargets } from '../../lib/people/work-email-review-lane.ts'
import { POST as WORK_EMAIL } from '../../app/api/leads/[lead]/work-email/route.ts'
import { POST as FIND_CONTACT } from '../../app/api/leads/[lead]/find-contact/route.ts'

const LINEAR_URL = 'https://linear.app/now/sharing-growth-with-the-people-building-linear'
// (declared before the transport below, which serves the vendor page at this path)
const LINEAR_TEXT = 'Sharing growth with the people building Linear. Linear grew fast. Salesforce and Figma, which both became customers earlier this year. Many leading AI companies, including OpenAI, also run product development in Linear.'
const SITE = 'figma.test'
const PERSON = 'Dana Whitfield, Chief Financial Officer'
const TARGET = 'Dana Whitfield|Chief Financial Officer'

const html = (b: string) => `<html><body>${b}</body></html>`
const t = await installFixtureTransport({
  [SITE]: { '/robots.txt': 'User-agent: *\nAllow: /', '/': html('Figma, San Francisco, CA <a href="/contact">Contact</a>'), '/contact': html('<a href="mailto:hello@figma.test">hello</a>') },
  'linear.app': { '/robots.txt': '', [new URL(LINEAR_URL).pathname]: html(`<h1>Sharing growth with the people building Linear</h1><p>${LINEAR_TEXT.replace(/^Sharing growth with the people building Linear\. /, '').replace('Figma', '<a href="https://figma.test/">Figma</a>')}</p>`) },
})

const apolloCalls: string[] = []
globalThis.fetch = (async (u: RequestInfo | URL) => {
  const url = String(u)
  if (!/apollo\.io/.test(url)) throw new Error(`Unexpected network call: ${url}`)
  apolloCalls.push(url)
  return new Response(JSON.stringify({ person: { name: 'Dana Whitfield', first_name: 'Dana', last_name: 'Whitfield', title: 'Chief Financial Officer', email: 'dana.whitfield@figma.test', email_status: 'verified', country: 'United States', organization: { primary_domain: SITE } } }), { status: 200 })
}) as typeof fetch
const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64')

const db = new Database(':memory:'); migrateAllSqlite(db)
const job = createJob(db, 'A', { business_name: 'Seller', industry: 'software', location: 'San Francisco' })
db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 'Software companies', who: ['Chief Financial Officer'], where: ['San Francisco, CA'], signals: [] }), job)
saveCredential(db, 'A', 'enrich:apollo', 'test-apollo-key-1177', master)
setScanDb(db); setUser({ id: 'A', business_name: 'Seller' })

const now = Math.floor(Date.now() / 1000), today = new Date().toISOString().slice(0, 10)
let n = 0
// One row per case: the cited page is the vendor's (LINEAR_URL) unless `source` says otherwise; `domains` are the website rows
// an earlier crawl recorded for it ("<site>|<basis>").
function seed(company: string, reason: string, domains: string[], source: string | null = LINEAR_URL): string {
  const id = (++n).toString(16).padStart(24, 'c')
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, evidence_excerpt, confidence, review_reason) VALUES (?, ?, '', ?, ?, ?, ?, 80, ?)")
    .run(id, job, company, LINEAR_TEXT, source, LINEAR_TEXT, reason)
  const add = (kind: string, value: string, label: string | null, url: string) => db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'sitecrawl', ?, ?, ?, 70, ?, ?, ?)")
    .run(randomBytes(12).toString('hex'), id, kind, value, label, url, today, now)
  for (const d of domains) { const [site, basis] = d.split('|'); add('domain', d, `domain-basis-v1:${basis}`, basis === 'evidence_own_domain' ? `https://${site}/` : source ?? '') }
  add('person', PERSON, null, `https://${domains[0]?.split('|')[0] ?? SITE}/about`)
  return id
}
const hdr = { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' }
const workEmail = (id: string) => (fresh(), WORK_EMAIL(new NextRequest(`http://localhost/api/leads/${id}/work-email`, { method: 'POST', headers: hdr, body: JSON.stringify({ target: TARGET }) }), { params: Promise.resolve({ lead: id }) }))
// Each case is a separate click; the per-tenant limits (find-contact 10/min, work-email 20/min) would refuse later cases with 429, so the
// fixture store's counters are cleared before each call (test state only).
const fresh = () => db.prepare('DELETE FROM rate_limits').run()
const findContact = (id: string) => (fresh(), FIND_CONTACT(new NextRequest(`http://localhost/api/leads/${id}/find-contact`, { method: 'POST', headers: hdr, body: '{}' }), { params: Promise.resolve({ lead: id }) }))
// The Leads page's view of the same row (what leads-client.tsx passes: the lead with its stored rows).
const pageRow = (id: string) => {
  const l = db.prepare('SELECT id, company, contact, source_url, source_kind, review_reason, human_confirmed_from, quarantined_at FROM leads WHERE id = ?').get(id) as Record<string, unknown>
  return { ...l, enrichments: db.prepare('SELECT connector, kind, value, label, source_url, source_date, retrieved_at, confidence FROM lead_enrichments WHERE lead_id = ?').all(id) } as never
}

test('#1177 a customer-mention row with its own settled website: Find work email runs for its buyer, the row stays in review', async () => {
  const id = seed('Figma', 'counterparty_signal', [`${SITE}|evidence_own_domain`])
  assert.deepEqual(reviewLaneWorkEmailTargets(pageRow(id), 'Chief Financial Officer').map(x => x.key), [TARGET], 'the Leads page offers the button')
  const r = await workEmail(id)
  const body = await r.json() as { status: string; lookup?: { address: string } }
  assert.equal(r.status, 200, JSON.stringify(body))
  assert.equal(body.status, 'verified'); assert.equal(body.lookup?.address, 'dana.whitfield@figma.test')
  assert.equal(apolloCalls.length, 1)
  assert.deepEqual(db.prepare('SELECT review_reason, human_confirmed_at FROM leads WHERE id = ?').get(id), { review_reason: 'counterparty_signal', human_confirmed_at: null }, 'the hold is not cleared')
})

test('#1177 the same row after "Keep as research": Find contact crawls its OWN site, never the vendor page it was cited from', async () => {
  const id = seed('Figma', 'counterparty_signal', [`${SITE}|evidence_own_domain`])
  assert.equal(await confirmLeadReview(sqliteDb(db), 'A', id), true)
  assert.equal(companySearchEligible(pageRow(id)), true, 'the Leads page offers Find contact')
  const before = t.hits.length
  const r = await findContact(id)
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
  assert.deepEqual(await r.json(), { searched: true, found: 1 })
  const hits = t.hits.slice(before)
  assert.ok(hits.length > 0 && hits.every(h => h.startsWith(`${SITE}/`)), hits.join(', '))
  const rows = db.prepare("SELECT kind, value, source_url FROM lead_enrichments WHERE lead_id = ? AND kind IN ('email', 'domain') ORDER BY kind").all(id)
  assert.deepEqual(rows, [{ kind: 'domain', value: `${SITE}|evidence_own_domain`, source_url: `https://${SITE}/` }, { kind: 'email', value: `hello@${SITE}`, source_url: `https://${SITE}/contact` }], 'one website, still its own; the mailbox is on it')
  // The decided card's Find work email (leads-client.tsx workEmailLeadEligible) and its route agree on the confirmed row.
  assert.equal(workEmailLeadEligible(pageRow(id)), true)
  const w = await workEmail(id)
  assert.equal(w.status, 200); assert.equal((await w.json() as { status: string }).status, 'verified')
})

test('#1177 correct holds stay refused on both routes and the page: unsettled site, the vendor\'s own site, two sites, a person\'s post', async () => {
  const cases: [string, string, string, string[], string?][] = [
    ['website only linked from the vendor page', 'Figma', 'counterparty_signal', [`${SITE}|evidence_link_domain_label`]],
    ['website only guessed from the name', 'Figma', 'counterparty_signal', [`${SITE}|name_probe`]],
    ['no website recorded', 'Figma', 'counterparty_signal', []],
    ['the "own" site recorded is the cited vendor page\'s site (wrong company)', 'Figma', 'counterparty_signal', ['linear.app|evidence_own_domain']],
    ['two websites recorded (not settled)', 'Figma', 'counterparty_signal', [`${SITE}|evidence_own_domain`, 'figma-other.test|evidence_own_domain']],
    ['a person\'s own post (author_post) even with a settled site', 'Figma', 'author_post', [`${SITE}|evidence_own_domain`]],
    ['the "own" site is the parent of the cited vendor subdomain', 'Figma', 'counterparty_signal', ['linear.app|evidence_own_domain'], 'https://blog.linear.app/x'],
    ['the cited page is on the "own" site itself (www)', 'Figma', 'counterparty_signal', [`${SITE}|evidence_own_domain`], `https://www.${SITE}/story`],
    ['the cited page is on a subdomain of the "own" site', 'Figma', 'counterparty_signal', [`${SITE}|evidence_own_domain`], `https://blog.${SITE}/x`],
  ]
  for (const [why, company, reason, domains, source] of cases) {
    const id = seed(company, reason, domains, source === undefined ? LINEAR_URL : source)
    assert.deepEqual(reviewLaneWorkEmailTargets(pageRow(id), 'Chief Financial Officer'), [], `page, ${why}`)
    const calls = apolloCalls.length
    const w = await workEmail(id)
    assert.equal(w.status, 422, `work email, ${why}`); assert.equal(apolloCalls.length, calls, `no provider call, ${why}`)
    assert.equal(await confirmLeadReview(sqliteDb(db), 'A', id), true)
    assert.equal(companySearchEligible(pageRow(id)), false, `page Find contact, ${why}`)
    const hits = t.hits.length
    assert.equal((await findContact(id)).status, 422, `find contact, ${why}`); assert.equal(t.hits.length, hits, `no crawl, ${why}`)
  }
  // A website the user confirmed in the website review, but linked only from the vendor page: not an own-domain basis.
  const id = seed('Figma', 'counterparty_signal', [`${SITE}|evidence_link_domain_label`])
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'sitecrawl', 'email', ?, NULL, 70, ?, ?, ?)").run(randomBytes(12).toString('hex'), id, `hello@${SITE}`, `https://${SITE}/contact`, today, now)
  const bind = domainReviewFor({ id, contact: null }, db.prepare('SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ?').all(id) as never).binding!
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'user', 'domain_review', ?, ?, NULL, ?, ?, ?)").run(randomBytes(12).toString('hex'), id, SITE, REVIEW_PREFIX + bind, LINEAR_URL, today, now) // as domain-review-action.ts writes it (source: the basis page)
  assert.equal(domainReviewFor({ id, contact: null }, pageRow(id)['enrichments' as never]).state, 'confirmed', 'the review is current')
  assert.deepEqual(reviewLaneWorkEmailTargets(pageRow(id), 'Chief Financial Officer'), [], 'page, user-confirmed only')
  assert.equal((await workEmail(id)).status, 422, 'work email, user-confirmed only')
  assert.equal(await confirmLeadReview(sqliteDb(db), 'A', id), true)
  assert.equal(companySearchEligible(pageRow(id)), false); assert.equal(workEmailLeadEligible(pageRow(id)), false)
  assert.equal((await findContact(id)).status, 422, 'find contact, user-confirmed only')
  // The leads table only stores an http(s) cited URL; the page rule itself also refuses a row whose cited page is unreadable or missing.
  const own = [{ connector: 'sitecrawl', kind: 'domain', value: `${SITE}|evidence_own_domain`, label: 'domain-basis-v1:evidence_own_domain', source_url: `https://${SITE}/` }]
  for (const source_url of ['not a url', null, '']) assert.equal(companySearchEligible({ company: 'Figma', source_url, human_confirmed_from: 'counterparty_signal', enrichments: own }), false, String(source_url))
  assert.equal(companySearchEligible({ company: 'Figma', source_url: LINEAR_URL, human_confirmed_from: 'counterparty_signal', enrichments: own }), true, 'the same rows with the vendor page cited')
  // A row with no stored rows at all (what an older page payload without enrichments carries) is refused.
  assert.equal(companySearchEligible({ company: 'Figma', source_url: LINEAR_URL, human_confirmed_from: 'counterparty_signal' }), false)
  assert.equal((db.prepare('SELECT count(*) AS n FROM work_email_lookups').get() as { n: number }).n, 2, 'only the two settled rows above were looked up')
})

test('#1177 the real crawler on the real vendor wording: the customer\'s site comes out linked-only, so the row stays refused', async () => {
  const id = seed('Figma', 'counterparty_signal', [])
  db.prepare("DELETE FROM lead_enrichments WHERE lead_id = ?").run(id)
  await crawlJob(db, 'A', job, { leads: [{ id, company: 'Figma', source_url: LINEAR_URL }], gapMs: 0, env: {} })
  const dom = db.prepare("SELECT value, source_url FROM lead_enrichments WHERE lead_id = ? AND kind = 'domain'").all(id)
  assert.deepEqual(dom, [{ value: `${SITE}|evidence_link_domain_label`, source_url: LINEAR_URL }], 'linked from the vendor page, never its own domain')
  assert.deepEqual(reviewLaneWorkEmailTargets(pageRow(id), 'Chief Financial Officer'), [])
  const calls = apolloCalls.length
  assert.equal((await workEmail(id)).status, 422); assert.equal(apolloCalls.length, calls)
  assert.equal(await confirmLeadReview(sqliteDb(db), 'A', id), true)
  assert.equal(companySearchEligible(pageRow(id)), false)
  assert.equal((await findContact(id)).status, 422)
})

test.after(() => t.close())
