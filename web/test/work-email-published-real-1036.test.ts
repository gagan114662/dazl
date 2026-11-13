// #1036 real-data regression (NEVER-AGAIN #5: built from real prod-shaped data). A real Austin brokerage's team page (read
// 2026-11-13; names and domain replaced with synthetic ones, the markup kept as the site serves it) lists each person as a card: <span class="team-member__name"> /
// <span class="team-member__role"> with the person's own address in the card's data. With prod settings (EMAIL_GUESS_ENABLED off,
// no Apollo / PDL key), the crawl must record that address as PUBLISHED for the named buyer, and one click on Find work email must
// show it as "Published work email" with the page. Before the fix the flag being off dropped every printed address, so the same
// click answered no_key. Card markup below is the real page's structure (images, scripts and the other agents trimmed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { enrichmentsForLeads } from '../lib/connectors/store.ts'
import { identityOf } from '../lib/scan/opportunity.ts'
import { findWorkEmail } from '../lib/people/work-email.ts'
import { targetKey, workEmailCopy, workEmailTargets } from '../lib/people/work-email-eligible.ts'

const PROSE = '<p>Bluebonnet Realty is a boutique real estate firm servicing the Greater Austin area. We help buyers and sellers with every step of the process, and we care about the neighborhoods we work in and the people who live there.</p>'
const card = (name: string, email: string, role: string, slug: string) => `<div class="team-member__container" data-search-string="${name} ${email}" data-tags="[]" > <a class="team-member__link" href="/agent/${slug}"> <div class="team-member__image-wrap"> <div class="team-member__image"> </div> <div class="team-member__hover"> <span class="btn btn--primary-dark team-member__btn button-style-1">LEARN MORE</span> </div> </div> <div class="team-member__info"> <span class="team-member__name">${name}</span> <span class="team-member__role">${role}</span> </div> </a> </div>`
const html = (b: string) => `<html><body>${b}</body></html>`
const page = (team: string): Record<string, string> => ({
  '/robots.txt': 'User-agent: *\nAllow: /',
  '/': html(`${PROSE}<p>Bluebonnet Realty, 100 Example Ave, Austin, TX 78702</p><a href="/team">Our Team</a><a href="/contact">Contact</a>`),
  '/team': html(`${PROSE}<div class="team-grid__wrapper ordered-elements">${team}</div>`),
  '/contact': html(`${PROSE}<a href="mailto:hello@bluebonnetrealty.com">hello</a>`),
})
const TEAM = `${card('Maya Thornton', 'maya@bluebonnetrealty.com', 'Real Estate Broker | Owner', 'maya-thornton')}${card('Owen Pike', 'owen@bluebonnetrealty.com', 'Real Estate Agent', 'owen-pike-1')}`
const ICP = { summary: 'Austin real-estate brokerages', who: ['Broker', 'Owner'], where: ['Austin, TX'], signals: [] }

async function run(env: Record<string, string>, team = TEAM) {
  const PAGES = page(team)
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const job = createJob(db, 'T', { business_name: 'Seller', industry: 'proptech', location: 'Austin, TX' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify(ICP), job)
  const lead = 'c'.repeat(24)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(lead, job, 'Bluebonnet Realty', null, 'Boutique Austin brokerage', 'https://bluebonnetrealty.com/', 'Bluebonnet Realty, a boutique real estate firm servicing the Greater Austin area', 90, 80)
  const get: Get = async url => { const p = PAGES[new URL(url).pathname]; return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 'T', job, { get, gapMs: 0, env, now: Date.parse('2026-11-13T12:00:00Z') })
  const rows = enrichmentsForLeads(db, 'T', [lead])[lead] ?? []
  const site = identityOf({ id: lead, contact: null }, rows)
  const targets = workEmailTargets(rows, ICP.who.join('; '), Date.parse('2026-11-13T12:00:00Z'), site).map(targetKey)
  const calls: string[] = []
  const r = await findWorkEmail(db, 'T', lead, 'Maya Thornton|Real Estate Broker | Owner', { env, now: 1_794_000_000, fetchImpl: (async (u: RequestInfo | URL) => { calls.push(String(u)); throw new Error('no provider call expected') }) as typeof fetch })
  return { site, targets, r, calls }
}

test('#1036 real brokerage page, prod settings (guessing off, no keys): one click shows the buyer\'s published work email with its page', async () => {
  const { site, targets, r, calls } = await run({})
  assert.equal(site?.state, 'fact'); assert.equal(site?.site, 'bluebonnetrealty.com')
  assert.deepEqual(targets, ['Maya Thornton|Real Estate Broker | Owner'], 'the broker/owner is the one buyer-role target; the agent is not')
  assert.equal(r.status, 'published', JSON.stringify(r))
  const row = (r as { row: Parameters<typeof workEmailCopy>[0] }).row
  assert.deepEqual([row.address, row.source_url, row.provider], ['maya@bluebonnetrealty.com', 'https://bluebonnetrealty.com/team', 'site'])
  const c = workEmailCopy(row); assert.equal(c.headline, 'Published work email'); assert.equal(c.checked, true); assert.equal(c.showAddress, true)
  assert.deepEqual(calls, [], 'free: no provider was called')
})

// Independent review R2: a first-name-only address is attributed only when the page prints that person's full name beside it.
test('#1036 a first-name-only address printed away from the person (or beside another Maya) is nobody\'s published address', async () => {
  const footer = `${card('Maya Thornton', '', 'Real Estate Broker | Owner', 'maya-thornton')}${card('Maya Ortiz', '', 'Real Estate Agent', 'maya-ortiz')}${'<p>Office hours and listings.</p>'.repeat(20)}<footer><p>Questions? Write to maya@bluebonnetrealty.com</p></footer>`
  const { r } = await run({}, footer)
  assert.notEqual(r.status, 'published', JSON.stringify(r))
})

// Hermes review at 989445c9, finding 1: the address sits in ANOTHER person's card (same first name, or same last name). The crawl
// keeps only the buyer, so only the page's own pairing can tell; a neighbouring card is not a pairing.
const c3 = (n: string, e: string, r: string) => card(n, e, r, n.toLowerCase().replace(/ /g, '-'))
const OWNER = 'Real Estate Broker | Owner', AGENT = 'Real Estate Agent'
const filler = ['Ava Lindqvist', 'Ben Okafor', 'Cora Whitfield', 'Dev Ramaswamy'].map(n => c3(n, '', AGENT)).join('')
for (const [label, team] of [
  ['another Maya\'s card holds maya@', `${c3('Maya Thornton', '', OWNER)}${c3('Maya Ortiz', 'maya@bluebonnetrealty.com', AGENT)}`],
  ['the same two cards inside a 6-person team', `${filler.slice(0, filler.length / 2)}${c3('Maya Thornton', '', OWNER)}${c3('Maya Ortiz', 'maya@bluebonnetrealty.com', AGENT)}${filler}`],
  ['another Thornton\'s card holds thornton@', `${c3('Maya Thornton', '', OWNER)}${c3('Tom Thornton', 'thornton@bluebonnetrealty.com', AGENT)}`],
] as const) {
  test(`#1036 wrong-person guard: ${label} -> nobody's published address for the buyer`, async () => {
    const { r, targets } = await run({}, team)
    assert.deepEqual(targets, ['Maya Thornton|Real Estate Broker | Owner'], 'precondition: the buyer is the one target')
    assert.notEqual(r.status, 'published', JSON.stringify(r))
  })
}
test('#1036 wrong-person guard, legit case: the address is in the buyer\'s OWN card and another Maya is elsewhere on the page -> still published', async () => {
  const { r } = await run({}, `${c3('Maya Thornton', 'maya@bluebonnetrealty.com', OWNER)}${c3('Maya Ortiz', '', AGENT)}${filler}`)
  assert.equal(r.status, 'published', JSON.stringify(r))
  assert.equal((r as { row: { address: string } }).row.address, 'maya@bluebonnetrealty.com')
})
test('#1036 wrong-person guard: visible text pairing ("Maya Thornton - maya@...") counts; the same text naming Maya Ortiz does not', async () => {
  const own = await run({}, `${c3('Maya Thornton', '', OWNER)}<p>Maya Thornton - maya@bluebonnetrealty.com</p>`)
  assert.equal(own.r.status, 'published', JSON.stringify(own.r))
  const other = await run({}, `${c3('Maya Thornton', '', OWNER)}<p>Maya Ortiz - maya@bluebonnetrealty.com</p>`)
  assert.notEqual(other.r.status, 'published')
})

// Finding 3: the context is built from the page lower-cased ONCE; a big staff directory must not cost a second of CPU per page.
test('#1036 address contexts on a 760 KB directory page with 1,500 addresses stay cheap (positions from the one scan, nothing built past 200 kept)', async () => {
  const { addressContexts } = await import('../lib/connectors/sitecrawl.ts')
  const { personalAddresses } = await import('../lib/people/email-pattern.ts')
  const cards = Array.from({ length: 1500 }, (_, i) => `<div class="card"><span>Person${i} Name${i}</span><a href="mailto:p${i}.name${i}@firm.com">p${i}.name${i}@firm.com</a>${'<p>bio text here</p>'.repeat(20)}</div>`).join('')
  const big = `<html><body>${cards}</body></html>`
  const src = (await import('node:fs')).readFileSync(new URL('../lib/connectors/sitecrawl.ts', import.meta.url), 'utf8')
  const loop = src.slice(src.indexOf('const onPage = (html: string, url: string, status: number) => {'), src.indexOf('const r = await crawlSite(cand, get'))
  assert.doesNotMatch(loop, /toLowerCase\(\)|indexOf\(/, 'the crawl loop never lower-cases or searches the page per address')
  assert.match(loop, /seen\.size >= 200\) continue/)
  // Relative to the existing address scan on the same machine at the same moment (robust under a loaded test run): the old
  // per-address lower-casing cost about 60x that scan, and one indexOf per address about 35x; the contexts for all 1,500 must stay within 12x (the crawl builds at most 200).
  const b0 = performance.now(); const found = personalAddresses(big, 'firm.com'); const base = Math.max(performance.now() - b0, 5)
  const t0 = performance.now(); let n = 0
  for (const a of found) n += addressContexts(big, a.at).length
  const ms = performance.now() - t0
  assert.ok(n >= 1500); assert.ok(ms < base * 12, `contexts for 1,500 addresses took ${Math.round(ms)} ms vs ${Math.round(base)} ms for the address scan`)
  // control: the per-address search this replaces is far over that bound on the same page
  const s0 = performance.now(); const lower = big.toLowerCase(); for (const a of found) lower.indexOf(a.address)
  assert.ok(performance.now() - s0 > base * 12, 'control: one page search per address would fail this bound')
})
