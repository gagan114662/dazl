import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { splitName, localFor, inferPattern, personalLocals, candidateAddress } from '../lib/people/email-pattern.ts'

// Email finder part 1 (docs/design/email-finder.md): pattern inference only. Candidates are unverified, kept in their
// own tables, never shown and never sent. TEST-ONLY fixtures, no network.

test('names split to ascii first/last; honorifics and accents handled; single names rejected', () => {
  assert.deepEqual(splitName('Dr. Ana María López-Pérez'), { first: 'ana', last: 'lopezperez' })
  assert.deepEqual(splitName('Dana Lee'), { first: 'dana', last: 'lee' })
  assert.equal(splitName('Madonna'), null)
  assert.equal(localFor('flast', { first: 'dana', last: 'lee' }), 'dlee')
  assert.equal(candidateAddress({ first: 'ben', last: 'ortiz' }, 'acme.com', 'first.last'), 'ben.ortiz@acme.com')
})

test('only personal addresses on the company domain count: role boxes and other domains are ignored', () => {
  const html = 'dana.lee@acme.com sales@acme.com info@acme.com pat.kim@uk.acme.com x.y@gmail.com mailto:ben.ortiz@ACME.com'
  assert.deepEqual(personalLocals(html, 'acme.com').sort(), ['ben.ortiz', 'dana.lee', 'pat.kim'])
})

test('a format needs 2+ supporting people and must be strictly ahead; otherwise no pattern', () => {
  const dana = { first: 'dana', last: 'lee' }, ben = { first: 'ben', last: 'ortiz' }, cara = { first: 'cara', last: 'diaz' }
  assert.deepEqual(inferPattern(['dana.lee', 'ben.ortiz'], [dana, ben, cara]), { format: 'first.last', support: 2 })
  assert.equal(inferPattern(['dana.lee'], [dana, ben]), null) // one example is not a pattern
  assert.equal(inferPattern(['dana.lee', 'bortiz'], [dana, ben]), null) // two formats, one each: ambiguous
  assert.equal(inferPattern(['someone.else', 'other.person'], [dana, ben]), null) // addresses not matching any listed person
})

const html = (b: string) => `<html><body>${b}</body></html>`
const PROSE = '<p>We have served the community for many years and we care about every family that walks through our doors every single day.</p>'
async function crawlFixture(env: Record<string, string>) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'Acme Logistics', null, 'Acme Logistics is hiring', 'https://news.example.test/a', 'Acme Logistics is hiring', 90, 80)
  const pages: Record<string, string> = {
    '/a': html('<a href="https://acmelogistics.com/">site</a>'),
    '/robots.txt': 'User-agent: *\nAllow: /',
    '/': html('Acme Logistics <a href="/team">Team</a><a href="/contact">Contact</a>'),
    '/team': html(`${PROSE}<h3>Dana Lee</h3><p>CEO</p><h3>Ben Ortiz</h3><p>CFO</p><h3>Cara Diaz</h3><p>COO</p><p>Press: dana.lee@acmelogistics.com, ben.ortiz@acmelogistics.com</p>`),
    '/contact': html('<a href="mailto:hello@acmelogistics.com">hello</a>'),
  }
  const get: Get = async url => { const p = pages[new URL(url).pathname]; return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env, now: Date.parse('2026-10-26T12:00:00Z') })
  return db
}

test('flag on: pattern and unverified candidates go to their own tables; lead_enrichments (shown and used by outreach) gets no guess', async () => {
  const db = await crawlFixture({ EMAIL_GUESS_ENABLED: '1' })
  assert.deepEqual(db.prepare('SELECT site, format, support FROM email_patterns').all(), [{ site: 'acmelogistics.com', format: 'first.last', support: 2 }])
  const cands = db.prepare('SELECT address, status FROM email_candidates ORDER BY address').all() as { address: string; status: string }[]
  assert.deepEqual(cands.map(c => c.address), ['ben.ortiz@acmelogistics.com', 'cara.diaz@acmelogistics.com', 'dana.lee@acmelogistics.com'])
  assert.ok(cands.every(c => c.status === 'unverified'))
  const enr = db.prepare("SELECT value FROM lead_enrichments WHERE kind <> 'domain'").all() as { value: string }[]
  assert.ok(enr.every(e => !e.value.includes('cara.diaz') && !e.value.includes('dana.lee@') && !e.value.includes('ben.ortiz@')), JSON.stringify(enr))
})

test('flag off (default): no tables, no candidates, crawl output unchanged', async () => {
  const db = await crawlFixture({})
  assert.equal((db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('email_patterns','email_candidates')").get() as { n: number }).n, 0)
  const enr = db.prepare("SELECT kind, value FROM lead_enrichments WHERE kind <> 'domain' ORDER BY kind, value").all()
  assert.deepEqual(enr, [{ kind: 'email', value: 'hello@acmelogistics.com' }, { kind: 'person', value: 'Ben Ortiz, CFO' }, { kind: 'person', value: 'Cara Diaz, COO' }, { kind: 'person', value: 'Dana Lee, CEO' }])
})
