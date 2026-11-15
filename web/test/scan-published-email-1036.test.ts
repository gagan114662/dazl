// #1036 (Hermes 23:37: labelled addresses on scanned leads DURING the scan). The same real brokerage page shape as
// test/work-email-published-real-1036.test.ts: the crawl already records the buyer's own printed address as PUBLISHED; now the scan
// also shows it on the lead as a published contact (an email enrichment naming the person and the page), with no click and no
// provider call. Never a guess; the wrong-person guards of the published tier decide, so a neighbour's card gives nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { enrichmentsForLeads } from '../lib/connectors/store.ts'
import { readContextLabel } from '../lib/outreach/contact-context.ts'

const PROSE = '<p>Bluebonnet Realty is a boutique real estate firm servicing the Greater Austin area. We help buyers and sellers with every step of the process, and we care about the neighborhoods we work in and the people who live there.</p>'
const card = (name: string, email: string, role: string, slug: string) => `<div class="team-member__container" data-search-string="${name} ${email}" data-tags="[]" > <a class="team-member__link" href="/agent/${slug}"> <div class="team-member__image-wrap"> <div class="team-member__image"> </div> <div class="team-member__hover"> <span class="btn btn--primary-dark team-member__btn button-style-1">LEARN MORE</span> </div> </div> <div class="team-member__info"> <span class="team-member__name">${name}</span> <span class="team-member__role">${role}</span> </div> </a> </div>`
const html = (b: string) => `<html><body>${b}</body></html>`
const page = (team: string, contactExtra = ''): Record<string, string> => ({
  '/robots.txt': 'User-agent: *\nAllow: /',
  '/': html(`${PROSE}<p>Bluebonnet Realty, 100 Example Ave, Austin, TX 78702</p><a href="/team">Our Team</a><a href="/contact">Contact</a>`),
  '/team': html(`${PROSE}<div class="team-grid__wrapper ordered-elements">${team}</div>`),
  '/contact': html(`${PROSE}<a href="mailto:hello@bluebonnetrealty.com">hello</a>${contactExtra}`),
})
const TEAM = `${card('Maya Thornton', 'maya@bluebonnetrealty.com', 'Real Estate Broker | Owner', 'maya-thornton')}${card('Owen Pike', 'owen@bluebonnetrealty.com', 'Real Estate Agent', 'owen-pike-1')}`
const ICP = { summary: 'Austin real-estate brokerages', who: ['Broker', 'Owner'], where: ['Austin, TX'], signals: [] }

async function scan(env: Record<string, string>, team = TEAM, where = ICP.where, home?: string) {
  const PAGES = page(team)
  if (home) PAGES['/'] = home
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const job = createJob(db, 'T', { business_name: 'Seller', industry: 'proptech', location: where[0] })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ ...ICP, where }), job)
  const lead = 'c'.repeat(24)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(lead, job, 'Bluebonnet Realty', null, 'Boutique Austin brokerage', 'https://bluebonnetrealty.com/', 'Bluebonnet Realty, a boutique real estate firm servicing the Greater Austin area', 90, 80)
  const calls: string[] = []
  const get: Get = async url => { calls.push(url); const p = PAGES[new URL(url).pathname]; return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 'T', job, { get, gapMs: 0, env, now: Date.parse('2026-11-13T12:00:00Z') })
  const rows = enrichmentsForLeads(db, 'T', [lead])[lead] ?? []
  return { emails: rows.filter(r => r.kind === 'email'), calls }
}
const c3 = (n: string, e: string, r: string) => card(n, e, r, n.toLowerCase().replace(/ /g, '-'))
const OWNER = 'Real Estate Broker | Owner', AGENT = 'Real Estate Agent'

test('the buyer\'s own printed address is on the lead after the scan, labelled with the person and the page; the role inbox stays as it was', async () => {
  for (const env of [{}, { EMAIL_GUESS_ENABLED: '1' }]) {
    const { emails } = await scan(env)
    const maya = emails.find(e => e.value === 'maya@bluebonnetrealty.com')
    assert.ok(maya, JSON.stringify(emails))
    assert.equal(maya!.source_url, 'https://bluebonnetrealty.com/team'); assert.equal(maya!.connector, 'sitecrawl')
    assert.equal(readContextLabel(maya!.label, maya!.source_url)?.excerpt, 'Maya Thornton, Real Estate Broker | Owner: their own address, printed on the company website')
    assert.ok(emails.some(e => e.value === 'hello@bluebonnetrealty.com'), 'the published role inbox is unchanged')
    assert.equal(emails.filter(e => e.value === 'maya@bluebonnetrealty.com').length, 1, 'once')
    assert.ok(!emails.some(e => e.value === 'owen@bluebonnetrealty.com'), 'only the people the crawl kept as this lead\'s buyers')
  }
})

test('nothing for an address in another person\'s card, for a first-name address printed away from the person, or outside the US (no address kept at rest)', async () => {
  for (const team of [`${c3('Maya Thornton', '', OWNER)}${c3('Maya Ortiz', 'maya@bluebonnetrealty.com', AGENT)}`, `${c3('Maya Thornton', '', OWNER)}<p>Maya Ortiz - maya@bluebonnetrealty.com</p>`]) {
    const { emails } = await scan({}, team)
    assert.ok(!emails.some(e => e.value === 'maya@bluebonnetrealty.com'), team.slice(0, 80))
  }
  const ca = await scan({}, TEAM, ['Toronto, ON'], `<html><body>${PROSE}<p>Bluebonnet Realty, 100 Example Ave, Toronto, ON M5V 2T6, Canada</p><a href="/team">Our Team</a><a href="/contact">Contact</a></body></html>`)
  assert.ok(!ca.emails.some(e => e.value === 'maya@bluebonnetrealty.com'), 'a non-US site keeps no personal address, so none is shown')
})
