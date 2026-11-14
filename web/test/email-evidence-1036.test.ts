// #1036 own email finder, part (a): more public evidence of a site's address format, each with its page.
// Real-data basis (2026-11-13, real crawl): beneschlaw.com prints "flast" addresses beside their owners on its contact, insight,
// practice and careers pages; whitleypenn.com prints dotted addresses in careers mailto links with no name near them. Markup shapes
// below follow those pages; names and domains are synthetic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { addressContexts, contactPaths, crawlJob, crawlSite, evidencePaths, EVIDENCE_PAGES, type Get } from '../lib/connectors/sitecrawl.ts'
import { contextOwners, migrateEmailGuess, personalAddresses, recordEmailGuesses, shapeOwners } from '../lib/people/email-pattern.ts'

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

// Review of 4b3b9025 #2: the crawl records guesses twice (after the main read, again after the evidence pages). A later read that
// changes the format must not leave the earlier generation behind as the only 'high' address the mailbox check would probe.
const ELIGIBLE = "SELECT address FROM email_candidates WHERE tenant_id = 'T' AND lead_id = 'L1' AND verification = 'none' AND country_basis IS NOT NULL AND tier = 'guessed' AND confidence = 'high' ORDER BY address"
const US_HOME = 'Harlow Reed LLP, 200 Example Plaza, Cleveland, OH 44114'
test('#1036 review 4b3b9025 #2: a second read that changes the learned format removes the first generation of unchecked guesses; the mailbox check can only probe the final format', () => {
  const db = new Database(':memory:'); migrateAllSqlite(db); migrateEmailGuess(db)
  const env = { EMAIL_GUESS_ENABLED: '1' }
  const firstPeople = ['Dana Whitcombe, Chief Marketing Officer', 'Ann Roe, Partner', 'Bo Lindqvist, Partner', 'Cy Ostrander, Partner']
  const r1 = recordEmailGuesses(db, 'T', 'L1', 'harlowreed.com', ['ann.roe', 'bo.lindqvist', 'cy.ostrander'], firstPeople, { env, homeText: US_HOME, where: ['Cleveland, OH'] })
  assert.deepEqual([r1?.format, r1?.confidence], ['first.last', 'high'])
  assert.ok((db.prepare(ELIGIBLE).all() as { address: string }[]).some(r => r.address === 'dana.whitcombe@harlowreed.com'), 'after the first read the first.last guess is what would be probed')
  // the evidence pages then print five "flast" addresses beside their owners: the format flips
  const more = ['Eve Baines, Associate', 'Lou Tapp, Recruiter', 'Max Wright, Counsel', 'Ned Quill, Counsel', 'Ola Brandt, Counsel']
  const r2 = recordEmailGuesses(db, 'T', 'L1', 'harlowreed.com', ['ann.roe', 'bo.lindqvist', 'cy.ostrander', 'ebaines', 'ltapp', 'mwright', 'nquill', 'obrandt'], [...firstPeople, ...more], { env, homeText: US_HOME, where: ['Cleveland, OH'] })
  assert.equal(r2?.format, 'flast')
  const rows = db.prepare("SELECT address, format, confidence FROM email_candidates WHERE tenant_id = 'T' AND lead_id = 'L1' AND tier = 'guessed' AND person LIKE 'Dana%'").all() as { address: string; format: string; confidence: string }[]
  assert.deepEqual(rows.map(r => [r.address, r.format]), [['dwhitcombe@harlowreed.com', 'flast']], 'the first.last guess is gone; only the final format remains')
  assert.equal(rows[0].confidence, r2?.confidence, 'the candidate carries the pattern\'s confidence')
  const eligible = (db.prepare(ELIGIBLE).all() as { address: string }[]).map(r => r.address)
  assert.ok(!eligible.includes('dana.whitcombe@harlowreed.com'), 'the obsolete address can never be probed')
  assert.ok(eligible.every(a => /^[a-z]+@/.test(a) && !a.split('@')[0].includes('.')), `only final-format addresses are eligible: ${eligible.join(', ')}`)
  assert.equal((db.prepare("SELECT count(*) AS n FROM email_candidates WHERE tier = 'guessed' AND format = 'first.last'").get() as { n: number }).n, 0)
})

test('#1036 review 4b3b9025 #2: a CHECKED guess keeps its row when the format changes (history), and the same format on a second read lowers the candidates with the pattern', () => {
  const db = new Database(':memory:'); migrateAllSqlite(db); migrateEmailGuess(db)
  const env = { EMAIL_GUESS_ENABLED: '1' }
  const people = ['Dana Whitcombe, Chief Marketing Officer', 'Ann Roe, Partner', 'Bo Lindqvist, Partner', 'Cy Ostrander, Partner']
  recordEmailGuesses(db, 'T', 'L1', 'harlowreed.com', ['ann.roe', 'bo.lindqvist', 'cy.ostrander'], people, { env, homeText: US_HOME, where: ['Cleveland, OH'] })
  db.prepare("UPDATE email_candidates SET verification = 'undeliverable' WHERE address = 'dana.whitcombe@harlowreed.com'").run()
  recordEmailGuesses(db, 'T', 'L1', 'harlowreed.com', ['ann.roe', 'bo.lindqvist', 'cy.ostrander', 'ebaines', 'ltapp', 'mwright', 'nquill', 'obrandt'], [...people, 'Eve Baines, A', 'Lou Tapp, R', 'Max Wright, C', 'Ned Quill, C', 'Ola Brandt, C'], { env, homeText: US_HOME, where: ['Cleveland, OH'] })
  assert.equal((db.prepare("SELECT verification FROM email_candidates WHERE address = 'dana.whitcombe@harlowreed.com'").get() as { verification: string }).verification, 'undeliverable', 'a checked row is history, never deleted')
})

test('#1036 review 4b3b9025 (xhawk): ONE shape-only supporter caps the format at medium, even beside genuinely paired ones (high is what gets probed)', () => {
  const db = new Database(':memory:'); migrateAllSqlite(db); migrateEmailGuess(db)
  // one address printed beside its owner (a named person on the site), two more dotted addresses with no name anywhere
  const seen = [{ address: 'ann.roe@harlowreed.com', url: 'https://harlowreed.com/team' }, { address: 'sam.keller@harlowreed.com', url: 'https://harlowreed.com/careers' }, { address: 'tia.novak@harlowreed.com', url: 'https://harlowreed.com/careers' }]
  const r = recordEmailGuesses(db, 'T', 'L1', 'harlowreed.com', [], ['Dana Whitcombe, Chief Marketing Officer', 'Ann Roe, Partner'], { env: { EMAIL_GUESS_ENABLED: '1' }, homeText: US_HOME, where: ['Cleveland, OH'], seen })
  assert.equal(r?.format, 'first.last'); assert.notEqual(r?.confidence, 'high')
  assert.deepEqual(db.prepare(ELIGIBLE).all(), [], 'nothing shape-derived is sent to the mailbox check')
})

// Review of 4b3b9025 (xhawk): the deferred evidence read has its own wall-clock budget and shares the per-host politeness clock.
const slowGet = (ms: number, starts: number[]): Get => async (url, o) => {
  const path = new URL(url).pathname; const p = PAGES[path]
  if (path !== '/robots.txt' && path !== '/' && path !== '/team' && path !== '/contact' && !['/contact-us', '/about', '/leadership'].includes(path)) {
    starts.push(Date.now())
    await new Promise<void>(res => { const t = setTimeout(res, ms); o?.signal?.addEventListener('abort', () => { clearTimeout(t); res() }, { once: true }) })
  }
  return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url }
}
test('#1036 review 4b3b9025: the evidence read stops at its own budget (never above the crawl budget): no fetch starts after it', async () => {
  const starts: number[] = []
  const r = await crawlSite('harlowreed.com', slowGet(250, starts), 0, 'Harlow Reed', false, undefined, () => {}, undefined, 600)
  assert.ok(r.later, 'evidence pages were found')
  const t0 = Date.now(); starts.length = 0
  await r.later!()
  assert.ok(Date.now() - t0 < 1200, `the evidence read took ${Date.now() - t0} ms under a 600 ms budget`)
  assert.ok(starts.length >= 1 && starts.length <= 3, `${starts.length} evidence fetches under a 600 ms budget with 250 ms pages (4 would be the unbounded read)`)
  assert.ok(starts.every(s => s - t0 < 600), 'no fetch started after the budget')
})

test('#1036 review 4b3b9025: two evidence reads of the same host at the same moment still keep the polite gap between every fetch', async () => {
  const starts: number[] = []; const GAP = 120
  const a = await crawlSite('harlowreed.com', slowGet(5, starts), GAP, 'Harlow Reed', false, undefined, () => {}, undefined, 20_000)
  const b = await crawlSite('harlowreed.com', slowGet(5, starts), GAP, 'Harlow Reed', false, undefined, () => {}, undefined, 20_000)
  starts.length = 0
  await Promise.all([a.later!(), b.later!()])
  const sorted = [...starts].sort((x, y) => x - y)
  assert.ok(sorted.length >= 4, `${sorted.length} evidence fetches in all`)
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i] - sorted[i - 1] >= GAP - 25, `fetches ${i - 1} and ${i} were ${sorted[i] - sorted[i - 1]} ms apart (gap ${GAP} ms)`)
})
