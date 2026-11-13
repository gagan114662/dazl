// #1036 real-data regression (NEVER-AGAIN #5: built from real prod-shaped data). A real Austin brokerage's team page
// (cultivaterealty.com/team, read 2026-11-13) lists each person as a card: <span class="team-member__name"> /
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

const PROSE = '<p>Cultivate Realty is a boutique real estate firm servicing the Greater Austin area. We help buyers and sellers with every step of the process, and we care about the neighborhoods we work in and the people who live there.</p>'
const card = (name: string, email: string, role: string, slug: string) => `<div class="team-member__container" data-search-string="${name} ${email}" data-tags="[]" > <a class="team-member__link" href="/agent/${slug}"> <div class="team-member__image-wrap"> <div class="team-member__image"> </div> <div class="team-member__hover"> <span class="btn btn--primary-dark team-member__btn button-style-1">LEARN MORE</span> </div> </div> <div class="team-member__info"> <span class="team-member__name">${name}</span> <span class="team-member__role">${role}</span> </div> </a> </div>`
const html = (b: string) => `<html><body>${b}</body></html>`
const PAGES: Record<string, string> = {
  '/robots.txt': 'User-agent: *\nAllow: /',
  '/': html(`${PROSE}<p>Cultivate Realty, 1000 E 5th St, Austin, TX 78702</p><a href="/team">Our Team</a><a href="/contact">Contact</a>`),
  '/team': html(`${PROSE}<div class="team-grid__wrapper ordered-elements">${card('Nora Wall', 'nora@cultivaterealty.com', 'Real Estate Broker | Owner', 'nora-wall')}${card('Angie Ufomata', 'angie@cultivaterealty.com', 'Real Estate Agent', 'angie-ufomata-1')}</div>`),
  '/contact': html(`${PROSE}<a href="mailto:hello@cultivaterealty.com">hello</a>`),
}
const ICP = { summary: 'Austin real-estate brokerages', who: ['Broker', 'Owner'], where: ['Austin, TX'], signals: [] }

async function run(env: Record<string, string>) {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const job = createJob(db, 'T', { business_name: 'Seller', industry: 'proptech', location: 'Austin, TX' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify(ICP), job)
  const lead = 'c'.repeat(24)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(lead, job, 'Cultivate Realty', null, 'Boutique Austin brokerage', 'https://cultivaterealty.com/', 'Cultivate Realty, a boutique real estate firm servicing the Greater Austin area', 90, 80)
  const get: Get = async url => { const p = PAGES[new URL(url).pathname]; return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 'T', job, { get, gapMs: 0, env, now: Date.parse('2026-11-13T12:00:00Z') })
  const rows = enrichmentsForLeads(db, 'T', [lead])[lead] ?? []
  const site = identityOf({ id: lead, contact: null }, rows)
  const targets = workEmailTargets(rows, ICP.who.join('; '), Date.parse('2026-11-13T12:00:00Z'), site).map(targetKey)
  const calls: string[] = []
  const r = await findWorkEmail(db, 'T', lead, 'Nora Wall|Real Estate Broker | Owner', { env, now: 1_794_000_000, fetchImpl: (async (u: RequestInfo | URL) => { calls.push(String(u)); throw new Error('no provider call expected') }) as typeof fetch })
  return { site, targets, r, calls }
}

test('#1036 real brokerage page, prod settings (guessing off, no keys): one click shows the buyer\'s published work email with its page', async () => {
  const { site, targets, r, calls } = await run({})
  assert.equal(site?.state, 'fact'); assert.equal(site?.site, 'cultivaterealty.com')
  assert.deepEqual(targets, ['Nora Wall|Real Estate Broker | Owner'], 'the broker/owner is the one buyer-role target; the agent is not')
  assert.equal(r.status, 'published', JSON.stringify(r))
  const row = (r as { row: Parameters<typeof workEmailCopy>[0] }).row
  assert.deepEqual([row.address, row.source_url, row.provider], ['nora@cultivaterealty.com', 'https://cultivaterealty.com/team', 'site'])
  const c = workEmailCopy(row); assert.equal(c.headline, 'Published work email'); assert.equal(c.checked, true); assert.equal(c.showAddress, true)
  assert.deepEqual(calls, [], 'free: no provider was called')
})
