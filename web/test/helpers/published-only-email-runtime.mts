// #1036 / #1250: the buyer's email is only an address published on the company's own domain. On an ordinary scan (not company-first,
// not QA-only) with every old input present (the tenant's Apollo and People Data Labs keys, guessing switched on, a mailbox verifier
// configured, a stored mailbox-checked guess and a stored Apollo answer), the real Find work email route and the Leads page preload show
// none of it, call no provider or verifier, and give the address the company prints on its own site. Synthetic company; fetch throws.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { GET as WE_GET, POST as WE_POST } from '../../app/api/leads/[lead]/work-email/route.ts'
import { saveCredential, setEnrichFallback } from '../../lib/connectors/store.ts'
import { createJob } from '../../lib/scan/store.ts'
import { workEmailPageRead } from '../../lib/people/work-email.ts'
import { recordEmailGuesses } from '../../lib/people/email-pattern.ts'

let fetches = 0
globalThis.fetch = (async () => { fetches++; throw new Error('Unexpected network call') }) as typeof fetch
const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64')
const OLD_INPUTS = { EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '5', EMAIL_VERIFY_MONTHLY_CAP: '100', ZEROBOUNCE_API_KEY: 'synthetic-zerobounce-key' }
Object.assign(process.env, OLD_INPUTS)
const hdr = { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' }
const site = 'harbordental.example', bio = `https://${site}/team`, home = '1 Main St, New York, NY 10001'
const target = 'Dana Lee|Practice Manager', person = 'Dana Lee, Practice Manager'

function ordinaryLead() {
  const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db); setUser({ id: 'A', business_name: 'Acme' })
  saveCredential(db, 'A', 'enrich:apollo', 'real-looking-apollo-key-9999', master)
  saveCredential(db, 'A', 'enrich:pdl', 'real-looking-pdl-key-9999', master)
  setEnrichFallback(db, 'A', true)
  const now = Math.floor(Date.now() / 1000), lead = randomBytes(12).toString('hex')
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'dental', location: 'New York' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ who: ['Practice Manager'], where: ['New York, NY'] }), job)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, confidence) VALUES (?, ?, '', 'Harbor Dental', ?, 'hiring', ?, 80)").run(lead, job, site, bio)
  const add = db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'sitecrawl', ?, ?, ?, ?, '2026-11-19', ?)")
  add.run(randomBytes(12).toString('hex'), lead, 'domain', `${site}|evidence_own_domain`, 'domain-basis-v1:evidence_own_domain', bio, now)
  add.run(randomBytes(12).toString('hex'), lead, 'person', person, null, bio, now)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  const params = { params: Promise.resolve({ lead }) }, url = `http://localhost/api/leads/${lead}/work-email`
  return {
    db, lead, now,
    get: () => WE_GET(new NextRequest(url), params),
    post: () => WE_POST(new NextRequest(url, { method: 'POST', body: JSON.stringify({ target }), headers: hdr }), params),
  }
}

test('ordinary scan: no guess, no stored Apollo answer, no provider or mailbox call; the published address only', async () => {
  const s = ordinaryLead()
  // what the old flows left behind: a learned-format guess the mailbox check passed, and Apollo's own "verified" answer
  s.db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis, tier, confidence, verification, verifier, checked_at) VALUES ('A', ?, ?, ?, 'first.last', 'homepage address: NY 10001', 'guessed', 'high', 'verified', 'zerobounce', ?)")
    .run(s.lead, person, `dana.lee@${site}`, s.now)
  s.db.prepare("INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, provider, address, checked_at, updated_at) VALUES ('A', ?, ?, 'verified', 'apollo', ?, ?, ?)").run(s.lead, target, `dlee@${site}`, s.now, s.now)
  const before = fetches
  const read = await (await s.get()).json() as { providers: { apollo: boolean; pdl: boolean; mailboxCheck: boolean; publishedOnly?: boolean }; lookups: unknown[]; guesses: unknown[] }
  assert.deepEqual([read.providers.apollo, read.providers.pdl, read.providers.mailboxCheck, read.providers.publishedOnly], [false, false, false, true])
  assert.deepEqual(read.lookups, [], 'a stored provider answer is not the buyer\'s email')
  assert.deepEqual(read.guesses, [], 'a guess is never shown, checked or not')
  const page = workEmailPageRead(s.db, 'A', [{ id: s.lead }])
  assert.deepEqual(page.lookups[s.lead] ?? [], [])
  assert.deepEqual(page.guesses[s.lead] ?? [], [])
  const clicked = await (await s.post()).json() as { status: string; lookup?: { address: string | null }; guess?: unknown }
  assert.deepEqual([clicked.status, clicked.lookup?.address ?? null, clicked.guess], ['not_found', null, undefined])
  assert.equal(fetches, before, 'no Apollo, People Data Labs or mailbox call')
  // the company prints the buyer's own address on its own page: that, and only that, is the buyer's email
  recordEmailGuesses(s.db, 'A', s.lead, site, [], [person], { env: OLD_INPUTS, homeText: home, seen: [{ address: `dana.lee@${site}`, url: bio }] })
  const found = await (await s.post()).json() as { status: string; lookup: { address: string | null; source_url: string | null; provider: string | null } }
  assert.deepEqual([found.status, found.lookup.address, found.lookup.source_url, found.lookup.provider], ['published', `dana.lee@${site}`, bio, 'site'])
  assert.equal(fetches, before)
  s.db.close()
})

test('recording the crawl\'s addresses writes published candidates only, never a guessed one, with guessing switched on', () => {
  const s = ordinaryLead()
  // two named people print first.last addresses: the old pattern step would have guessed the third person's address
  const people = ['Ann Bell, Owner', 'Ben Cole, Partner', person]
  recordEmailGuesses(s.db, 'A', s.lead, site, ['ann.bell', 'ben.cole'], people, { env: OLD_INPUTS, homeText: home,
    seen: [{ address: `ann.bell@${site}`, url: bio }, { address: `ben.cole@${site}`, url: bio }] })
  const rows = s.db.prepare('SELECT address, tier FROM email_candidates WHERE lead_id = ? ORDER BY address').all(s.lead)
  assert.deepEqual(rows, [{ address: `ann.bell@${site}`, tier: 'published' }, { address: `ben.cole@${site}`, tier: 'published' }])
  assert.equal(s.db.prepare("SELECT count(*) FROM email_patterns WHERE lead_id = ?").pluck().get(s.lead), 0, 'no learned format is kept to build addresses from')
  s.db.close()
})
