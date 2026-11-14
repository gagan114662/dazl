// #1036 own email finder, part (a): more public evidence of a site's address format, each with its page.
// Real-data basis (2026-11-13, real crawl): beneschlaw.com prints "flast" addresses beside their owners on its contact, insight,
// practice and careers pages; whitleypenn.com prints dotted addresses in careers mailto links with no name near them. Markup shapes
// below follow those pages; names and domains are synthetic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { addressContexts, contactPaths, crawlJob, evidencePaths, EVIDENCE_PAGES, type Get } from '../lib/connectors/sitecrawl.ts'
import { contextOwners, personalAddresses, shapeOwners } from '../lib/people/email-pattern.ts'

const html = (b: string) => `<html><body>${b}</body></html>`
const PROSE = '<p>Harlow Reed is a law firm serving clients across the region. We advise companies on employment, privacy and commercial matters, and we care about the people and the businesses we work with every day.</p>'
const HOME = html(`${PROSE}<p>Harlow Reed LLP, 200 Example Plaza, Cleveland, OH 44114</p><a href="/team">Team</a><a href="/contact">Contact</a><a href="/news-insights/">News</a><a href="/join-us-careers/">Careers</a><a href="/files/brochure.pdf">Brochure</a><a href="/news?page=2">More</a>`)
const PAGES: Record<string, string> = {
  '/robots.txt': 'User-agent: *\nAllow: /',
  '/': HOME,
  '/team': html(`${PROSE}<h3>Dana Whitcombe</h3><p>Chief Marketing Officer</p>`),
  '/contact': html(`${PROSE}<a href="mailto:info@harlowreed.com">info</a>`),
  '/news-insights/': html(`${PROSE}<p>Media contact: Corinne Wright, <a href="mailto:cwright@harlowreed.com">cwright@harlowreed.com</a></p><p>Author: Eric Baines (ebaines@harlowreed.com)</p>`),
  '/join-us-careers/': html(`${PROSE}<p>Send your CV to Lauren Tapp at ltapp@harlowreed.com</p>`),
}
const get: Get = async url => { const p = PAGES[new URL(url).pathname]; return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url } }

async function crawl(env: Record<string, string>) {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const job = createJob(db, 'T', { business_name: 'Seller', industry: 'x', location: 'Cleveland, OH' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', who: ['Chief Marketing Officer'], where: ['Cleveland, OH'], signals: [] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)').run('d'.repeat(24), job, 'Harlow Reed', null, 'opened an office', 'https://harlowreed.com/', 'Harlow Reed', 90, 80)
  const read: string[] = []
  await crawlJob(db, 'T', job, { get: async (u, o) => { read.push(new URL(u).pathname); return get(u, o) }, gapMs: 0, env, now: Date.parse('2026-11-13T12:00:00Z') })
  const q = (sql: string) => { try { return db.prepare(sql).all() as Record<string, unknown>[] } catch { return [] } }
  return { read, pattern: q('SELECT format, support, confidence, evidence FROM email_patterns'), guessed: q("SELECT person, address FROM email_candidates WHERE tier = 'guessed'"), enr: q("SELECT kind, value FROM lead_enrichments WHERE kind IN ('email','person') ORDER BY kind, value") }
}

test('#1036 evidence pages: linked press / careers pages are read after the contact pages, never files, query URLs or a page already read', () => {
  const p = evidencePaths(HOME, new URL('https://harlowreed.com/'))
  assert.equal(p[0], '/news-insights/', 'the site\'s own links first')
  assert.ok(!p.includes('/join-us-careers/'), 'the careers page is already one of the contact pages')
  assert.ok(!p.some(x => /\.pdf$|\?/.test(x))); assert.ok(p.includes('/press') && p.includes('/privacy'))
  const contact = new Set(contactPaths(HOME, new URL('https://harlowreed.com/'))); assert.ok(!p.some(x => contact.has(x)), 'no page twice')
  assert.equal(EVIDENCE_PAGES, 4)
})

test('#1036 the format is learned from addresses printed beside OTHER staff on press and careers pages, each with its page; the buyer gets a guess', async () => {
  const r = await crawl({ EMAIL_GUESS_ENABLED: '1' })
  assert.ok(r.read.includes('/news-insights/') && r.read.includes('/join-us-careers/'), `evidence pages were read: ${r.read.join(' ')}`)
  assert.equal(r.pattern.length, 1); assert.deepEqual([r.pattern[0].format, r.pattern[0].support, r.pattern[0].confidence], ['flast', 3, 'high'])
  const ev = JSON.parse(String(r.pattern[0].evidence)) as { person: string; address: string; url: string }[]
  assert.deepEqual(ev.map(e => [e.person, e.address, e.url]).sort(), [['corinne wright', 'cwright@harlowreed.com', 'https://harlowreed.com/news-insights/'], ['eric baines', 'ebaines@harlowreed.com', 'https://harlowreed.com/news-insights/'], ['lauren tapp', 'ltapp@harlowreed.com', 'https://harlowreed.com/join-us-careers/']])
  assert.deepEqual(r.guessed, [{ person: 'Dana Whitcombe, Chief Marketing Officer', address: 'dwhitcombe@harlowreed.com' }], 'only the buyer gets a candidate; the press and careers staff never do')
  // nothing else about the crawl result changes: no contact or person is taken from an evidence page
  assert.deepEqual(r.enr, [{ kind: 'email', value: 'info@harlowreed.com' }, { kind: 'person', value: 'Dana Whitcombe, Chief Marketing Officer' }])
})

test('#1036 with guessing off (prod today) the evidence pages record no pattern and no guess', async () => {
  const r = await crawl({})
  assert.deepEqual(r.pattern, []); assert.deepEqual(r.guessed, [])
})

const ctxOf = (h: string, site = 'x.com') => personalAddresses(h, site).map(a => ({ address: a.address, url: 'https://x.com/p', ctx: addressContexts(h, a.at) }))
test('#1036 contextOwners: a two-name address beside its owner\'s name teaches the format; a one-name address or a name that does not fit never does', () => {
  assert.deepEqual(contextOwners(ctxOf('<p>Media contact: Corinne Wright, <a href="mailto:cwright@x.com">cwright@x.com</a></p>')), [{ first: 'corinne', last: 'wright' }])
  assert.deepEqual(contextOwners(ctxOf('<p>Corinne Wright</p><a href="mailto:corinne.wright@x.com">Email</a>')), [{ first: 'corinne', last: 'wright' }], 'the name in the text around a mailto')
  assert.deepEqual(contextOwners(ctxOf('<p>Corinne Wright: corinne@x.com</p>')), [], 'a first-name address proves no format')
  assert.deepEqual(contextOwners(ctxOf('<p>Corinne Wright: jsmith@x.com</p>')), [], 'the name does not reproduce the address')
  assert.deepEqual(contextOwners(ctxOf('<p>Corinne Wright: cwright@x.com</p>'), [{ first: 'corinne', last: 'wright' }]), [], 'a known person is not repeated')
})

test('#1036 shapeOwners: two distinct dotted addresses read as first.last (capped at medium by the caller); one alone proves nothing', () => {
  assert.deepEqual(shapeOwners(['shannon.spees', 'jennifer.morales', 'info']), [{ first: 'shannon', last: 'spees' }, { first: 'jennifer', last: 'morales' }])
  assert.deepEqual(shapeOwners(['whitley.penn']), [], 'a single dotted address may be the firm\'s own name')
  assert.deepEqual(shapeOwners(['shannon.spees', 'shannon.spees']), [])
  assert.deepEqual(shapeOwners(['shannon.spees', 'dana.lee'], [{ first: 'dana', last: 'lee' }]), [], 'a known person\'s address is not shape evidence')
})

test('#1036 a format shown only by the shape of two dotted addresses (no name printed with them) is recorded as medium, never high', async () => {
  const { recordEmailGuesses } = await import('../lib/people/email-pattern.ts')
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const seen = ['shannon.spees@x.com', 'jennifer.morales@x.com'].map(address => ({ address, url: 'https://x.com/careers/', ctx: [{ tight: `mailto:${address}`, wide: ' Learn More ', attr: true }] }))
  const r = recordEmailGuesses(db, 'T', 'L1', 'x.com', [], ['Emilia Dmello, Partner'], { env: { EMAIL_GUESS_ENABLED: '1' }, homeText: 'X LLP, 1 Main St, Dallas, TX 75201', seen })
  assert.deepEqual([r?.format, r?.confidence], ['first.last', 'medium'])
  assert.deepEqual(db.prepare("SELECT address, confidence FROM email_candidates WHERE tier = 'guessed'").all(), [{ address: 'emilia.dmello@x.com', confidence: 'medium' }])
  const one = recordEmailGuesses(new Database(':memory:'), 'T', 'L1', 'x.com', [], ['Emilia Dmello, Partner'], { env: { EMAIL_GUESS_ENABLED: '1' }, homeText: 'X LLP, 1 Main St, Dallas, TX 75201', seen: seen.slice(0, 1) })
  assert.equal(one, null, 'one dotted address alone teaches nothing')
})
