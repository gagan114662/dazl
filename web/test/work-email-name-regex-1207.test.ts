// #1207 (Refs #1036, #1173): the published-address guard built a RegExp from the buyer's first and last name unescaped, so a
// name holding a regex metacharacter threw ("thornton[" -> SyntaxError) or silently changed what it matched ("ma+ya" matched
// "Maaya Thornton"). Every name here must fail closed: no throw, no address attributed. Built on the real Austin brokerage team
// card markup from work-email-published-real-1036.test.ts (NEVER-AGAIN #5), read through the same functions the crawl uses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { addressContexts, crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { personalAddresses, publishedFor, reEscape, sameNamedPublication, singleNamePairing, type AddressContext, type Name } from '../lib/people/email-pattern.ts'
import { findWorkEmail } from '../lib/people/work-email.ts'

const SITE = 'bluebonnetrealty.com'
// The real page's card structure (names and domain synthetic), as in the #1036 real-data test.
const card = (name: string, email: string, role: string, slug: string) => `<div class="team-member__container" data-search-string="${name} ${email}" data-tags="[]" > <a class="team-member__link" href="/agent/${slug}"> <div class="team-member__image-wrap"> <div class="team-member__image"> </div> <div class="team-member__hover"> <span class="btn btn--primary-dark team-member__btn button-style-1">LEARN MORE</span> </div> </div> <div class="team-member__info"> <span class="team-member__name">${name}</span> <span class="team-member__role">${role}</span> </div> </a> </div>`
const seenFrom = (pageHtml: string) => {
  const seen = new Map<string, { address: string; url: string; ctx: AddressContext[] }>()
  for (const a of personalAddresses(pageHtml, SITE)) {
    const c = addressContexts(pageHtml, a.at)
    const had = seen.get(a.address)
    if (had) had.ctx.push(...c); else seen.set(a.address, { address: a.address, url: `https://${SITE}/team`, ctx: c })
  }
  return [...seen.values()]
}
const META = ['[', ']', '(', ')', '+', '*', '?', '.', '\\', '|', '^', '$', '{']

// Every outcome the guard gives for one name, collected without letting a throw escape the test's own bookkeeping.
const outcomes = (n: Name, printedName: string) => {
  // The card's own data attribute and a text line beside it, both pairing the printed name with the address.
  const seen = seenFrom(`${card(printedName, `maya@${SITE}`, 'Real Estate Broker | Owner', 'maya-thornton')}<p>${printedName} - maya@${SITE}</p>`)
  const ctx = seen[0]?.ctx
  const r: Record<string, unknown> = {}
  for (const [k, f] of Object.entries({
    publishedFor: () => publishedFor(n, seen)?.address ?? null,
    sameNamedPublication: () => sameNamedPublication(n, ctx),
    singleNamePairing: () => singleNamePairing('maya', n, ctx),
  })) { try { r[k] = f() } catch (e) { r[k] = `threw ${(e as Error).name}: ${(e as Error).message}` } }
  return r
}
const closed = { publishedFor: null, sameNamedPublication: false, singleNamePairing: false }

test('#1207 control: the plain buyer on the real card still gets her published address', () => {
  assert.deepEqual(outcomes({ first: 'maya', last: 'thornton' }, 'Maya Thornton'), { publishedFor: `maya@${SITE}`, sameNamedPublication: true, singleNamePairing: true })
})

test('#1207 a metacharacter in the first or the last name never throws and attributes no address, printed plainly or literally', () => {
  for (const m of META) {
    for (const [n, printed] of [
      [{ first: 'maya', last: `thornton${m}` }, `Maya Thornton${m}`],
      [{ first: `maya${m}`, last: 'thornton' }, `Maya${m} Thornton`],
      [{ first: `ma${m}ya`, last: 'thornton' }, `Ma${m}ya Thornton`],
      [{ first: 'maya', last: `thor${m}nton` }, `Maya Thor${m}nton`],
    ] as [Name, string][]) {
      assert.deepEqual(outcomes(n, printed), closed, `${JSON.stringify(n)} on a card printing "${printed}"`)
      assert.deepEqual(outcomes(n, 'Maya Thornton'), closed, `${JSON.stringify(n)} on a card printing "Maya Thornton"`)
    }
  }
})

test('#1207 "ma+ya" is not a pattern: it matches neither maya, maaya nor ma ya', () => {
  for (const printed of ['Maya Thornton', 'Maaya Thornton', 'Ma ya Thornton', 'Maaaaya Thornton']) {
    assert.deepEqual(outcomes({ first: 'ma+ya', last: 'thornton' }, printed), closed, printed)
  }
})

test('#1207 the name is escaped before it reaches new RegExp: every metacharacter matches only itself', () => {
  for (const m of META) {
    const re = new RegExp(`^${reEscape(`thor${m}nton`)}$`)
    assert.equal(re.test(`thor${m}nton`), true, m)
    for (const other of ['thornton', 'thorxnton', 'thor nton', `thor${m}${m}nton`]) assert.equal(re.test(other), false, `${m} vs ${other}`)
  }
  const ma = new RegExp(`^${reEscape('ma+ya')}$`, 'i')
  for (const w of ['maya', 'maaya', 'ma ya']) assert.equal(ma.test(w), false, w)
})

test('#1207 real route: a team page whose agent cards print ( ) [ ] | * + in their names crawls without a crash and one Find work email click still publishes the buyer\'s address', async () => {
  const team = [
    card('Maya Thornton', `maya@${SITE}`, 'Real Estate Broker | Owner', 'maya-thornton'),
    card('Owen Pike (He/Him)', `owen@${SITE}`, 'Real Estate Agent', 'owen-pike-1'),
    card('Lena Ruiz [Team Lead]', `lena@${SITE}`, 'Real Estate Agent', 'lena-ruiz'),
    card('J.R. Banks | REALTOR*', `jr@${SITE}`, 'Real Estate Agent', 'jr-banks'),
    card('Ana+Lee Cho', `ana@${SITE}`, 'Real Estate Agent', 'ana-lee-cho'),
  ].join('')
  const PROSE = '<p>Bluebonnet Realty is a boutique real estate firm servicing the Greater Austin area. We help buyers and sellers with every step of the process, and we care about the neighborhoods we work in and the people who live there.</p>'
  const html = (b: string) => `<html><body>${b}</body></html>`
  const PAGES: Record<string, string> = {
    '/robots.txt': 'User-agent: *\nAllow: /',
    '/': html(`${PROSE}<p>Bluebonnet Realty, 100 Example Ave, Austin, TX 78702</p><a href="/team">Our Team</a><a href="/contact">Contact</a>`),
    '/team': html(`${PROSE}<div class="team-grid__wrapper ordered-elements">${team}</div>`),
    '/contact': html(`${PROSE}<a href="mailto:hello@${SITE}">hello</a>`),
  }
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const ICP = { summary: 'Austin real-estate brokerages', who: ['Broker', 'Owner'], where: ['Austin, TX'], signals: [] }
  const job = createJob(db, 'T', { business_name: 'Seller', industry: 'proptech', location: 'Austin, TX' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify(ICP), job)
  const lead = 'd'.repeat(24)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(lead, job, 'Bluebonnet Realty', null, 'Boutique Austin brokerage', `https://${SITE}/`, 'Bluebonnet Realty, a boutique real estate firm servicing the Greater Austin area', 90, 80)
  const get: Get = async url => { const p = PAGES[new URL(url).pathname]; return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 'T', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-13T12:00:00Z') })
  const r = await findWorkEmail(db, 'T', lead, 'Maya Thornton|Real Estate Broker | Owner', { env: {}, now: 1_794_000_000, fetchImpl: (async () => { throw new Error('no provider call expected') }) as typeof fetch })
  assert.equal(r.status, 'published', JSON.stringify(r))
  const row = (r as { row: { address: string; source_url: string } }).row
  assert.deepEqual([row.address, row.source_url], [`maya@${SITE}`, `https://${SITE}/team`])
})
