// #1036 follow-up (stacked on #899): Find work email's Apollo -> PDL -> free-tier verifier waterfall. An address a provider found
// but did not verify gets the ZeroBounce free-tier check under the shared caps; only an explicit "valid" makes it checked.
// Stubbed HTTP only (invented company and person); no network, no credits.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { saveCredential, setEnrichFallback } from '../lib/connectors/store.ts'
import { findWorkEmail } from '../lib/people/work-email.ts'
import { workEmailCopy } from '../lib/people/work-email-eligible.ts'
import { recordEmailGuesses, verifyCandidates } from '../lib/people/email-pattern.ts'

const master = randomBytes(32)
const NOW = 1_800_000_000
const SITE = 'harbordental.example'
const DANA = 'Dana Lee|Practice Manager'
const ICP = { summary: 'NYC dental', where: ['New York, NY'], who: ['Practice manager', 'Owner'], signals: [] }
const ON = { EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '5', ZEROBOUNCE_API_KEY: 'zb-key' }

function seed(tenant = 'A') {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const job = createJob(db, tenant, { business_name: 'Seller', industry: 'software', location: 'New York' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify(ICP), job)
  const lead = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, confidence) VALUES (?, ?, '', 'Harbor Dental', ?, 'hiring', 'https://harbordental.example/careers', 80)").run(lead, job, SITE)
  const add = (connector: string, kind: string, value: string, source_url: string, label: string | null = null) =>
    db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, ?, ?, ?, ?, ?, 70, ?, '2026-11-01', ?)").run(randomBytes(12).toString('hex'), lead, tenant, connector, kind, value, label, source_url, NOW - 100)
  add('sitecrawl', 'domain', `${SITE}|evidence_own_domain`, `https://${SITE}/`, 'domain-basis-v1:evidence_own_domain')
  add('enrich:apollo', 'contact', 'Dana Lee - Practice Manager', 'https://www.linkedin.com/in/dana-lee-invented')
  saveCredential(db, tenant, 'enrich:apollo', 'test-apollo-key-1234', master)
  saveCredential(db, tenant, 'enrich:pdl', 'test-pdl-key-5678', master); setEnrichFallback(db, tenant, true)
  return { db, lead, tenant }
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
const apolloUnverified = () => json({ person: { name: 'Dana Lee', first_name: 'Dana', last_name: 'Lee', title: 'Practice Manager', email: 'dana.lee@harbordental.example', email_status: 'unverified', country: 'United States', linkedin_url: 'https://www.linkedin.com/in/dana-lee-invented', organization: { name: 'Harbor Dental', primary_domain: SITE } } })
type Calls = { apollo: number; pdl: number; zb: string[] }
const stub = (zb: () => Response, calls: Calls, apollo = apolloUnverified) => (async (u: RequestInfo | URL) => {
  const s = String(u)
  if (s.includes('apollo.io')) { calls.apollo++; return apollo() }
  if (s.includes('zerobounce.net')) { calls.zb.push(new URL(s).searchParams.get('email')!); return zb() }
  calls.pdl++; throw new Error('PDL must not be called: Apollo kept an address')
}) as typeof fetch
const run = (s: ReturnType<typeof seed>, f: typeof fetch, env: Record<string, string | undefined> = ON) => findWorkEmail(s.db, s.tenant, s.lead, DANA, { fetchImpl: f, master, now: NOW, env })
const copyOf = (r: Awaited<ReturnType<typeof run>>) => workEmailCopy((r as { row: Parameters<typeof workEmailCopy>[0] }).row)

test('#1036 Apollo found it unverified; ZeroBounce "valid" -> shown as a checked work email, with who checked it', async () => {
  const s = seed(); const calls: Calls = { apollo: 0, pdl: 0, zb: [] }
  const r = await run(s, stub(() => json({ status: 'valid' }), calls))
  assert.equal(r.status, 'unverified', 'the provider\'s own status is kept')
  assert.deepEqual(calls.zb, ['dana.lee@harbordental.example']); assert.equal(calls.pdl, 0)
  const row = (r as { row: { mailbox_check: string; mailbox_verifier: string } }).row
  assert.deepEqual([row.mailbox_check, row.mailbox_verifier], ['valid', 'zerobounce'])
  const c = copyOf(r)
  assert.equal(c.checked, true); assert.equal(c.headline, 'Checked work email')
  assert.match(c.note, /Found by Apollo; ZeroBounce confirmed the mailbox accepts mail on \d{4}-\d{2}-\d{2}/)
})

test('#1036 catch-all, unknown or an error never make it checked; undeliverable hides the address', async () => {
  for (const [zb, check, checked, shown] of [
    [() => json({ status: 'catch-all' }), 'catch_all', false, true],
    [() => json({ status: 'unknown' }), 'uncertain', false, true],
    [() => json({}, 503), 'uncertain', false, true],
    [() => json({ status: 'invalid' }), 'undeliverable', false, false],
  ] as [() => Response, string, boolean, boolean][]) {
    const s = seed(); const calls: Calls = { apollo: 0, pdl: 0, zb: [] }
    const r = await run(s, stub(zb, calls))
    assert.equal((r as { row: { mailbox_check: string } }).row.mailbox_check, check)
    const c = copyOf(r)
    assert.equal(c.checked, checked, check); assert.equal(c.showAddress, shown, check)
    if (check === 'catch_all') assert.match(c.note, /catch-all/)
  }
})

test('#1036 no check without the flag, the key or a daily cap: the address stays "Found, not checked", no ZeroBounce call', async () => {
  for (const env of [{ ...ON, EMAIL_GUESS_ENABLED: undefined }, { ...ON, ZEROBOUNCE_API_KEY: undefined }, { ...ON, EMAIL_VERIFY_DAILY_CAP: undefined }]) {
    const s = seed(); const calls: Calls = { apollo: 0, pdl: 0, zb: [] }
    const r = await run(s, stub(() => json({ status: 'valid' }), calls), env)
    assert.equal(calls.zb.length, 0, JSON.stringify(env))
    assert.equal(copyOf(r).headline, 'Found, not checked')
  }
})

test('#1036 an Apollo-verified address is not re-checked (no ZeroBounce call, no allowance used)', async () => {
  const s = seed(); const calls: Calls = { apollo: 0, pdl: 0, zb: [] }
  const r = await run(s, stub(() => json({ status: 'valid' }), calls, () => json({ person: { name: 'Dana Lee', first_name: 'Dana', last_name: 'Lee', title: 'Practice Manager', email: 'dana.lee@harbordental.example', email_status: 'verified', country: 'United States', linkedin_url: 'https://www.linkedin.com/in/dana-lee-invented', organization: { name: 'Harbor Dental', primary_domain: SITE } } })))
  assert.equal(r.status, 'verified'); assert.equal(calls.zb.length, 0)
})

test('#1036 the daily cap is shared with the scan\'s guess checks; the monthly allowance is the same ledger', async () => {
  const s = seed(); const calls: Calls = { apollo: 0, pdl: 0, zb: [] }
  // the scan already used today's one check (a guess on another lead)
  recordEmailGuesses(s.db, 'A', 'other-lead', 'acme.com', ['dana.lee', 'ben.ortiz'], ['Dana Lee, CEO', 'Ben Ortiz, CFO', 'Cara Diaz, COO'], { env: ON, homeText: '120 Main St, Austin, TX 78701' })
  await verifyCandidates(s.db, 'A', 'other-lead', { name: 'zerobounce', async verify() { return { outcome: 'deliverable' as const } } }, { env: { ...ON, EMAIL_VERIFY_DAILY_CAP: '1' }, now: NOW * 1000 })
  const r = await run(s, stub(() => json({ status: 'valid' }), calls), { ...ON, EMAIL_VERIFY_DAILY_CAP: '1' })
  assert.equal(calls.zb.length, 0, 'the tenant\'s daily cap was already used'); assert.equal(copyOf(r).checked, false)
  const s2 = seed(); const c2: Calls = { apollo: 0, pdl: 0, zb: [] }
  s2.db.prepare("INSERT INTO email_verify_usage (verifier, month, n) VALUES ('zerobounce', ?, 100)").run(new Date(NOW * 1000).toISOString().slice(0, 7))
  await run(s2, stub(() => json({ status: 'valid' }), c2))
  assert.equal(c2.zb.length, 0, 'the free monthly allowance is spent')
  // and a Find-work-email check counts against the scan's daily cap the other way round
  const s3 = seed(); const c3: Calls = { apollo: 0, pdl: 0, zb: [] }
  await run(s3, stub(() => json({ status: 'valid' }), c3), { ...ON, EMAIL_VERIFY_DAILY_CAP: '1' })
  recordEmailGuesses(s3.db, 'A', 'other-lead', 'acme.com', ['dana.lee', 'ben.ortiz'], ['Dana Lee, CEO', 'Ben Ortiz, CFO', 'Cara Diaz, COO'], { env: ON, homeText: '120 Main St, Austin, TX 78701' })
  let scanCalls = 0
  await verifyCandidates(s3.db, 'A', 'other-lead', { name: 'zerobounce', async verify() { scanCalls++; return { outcome: 'deliverable' as const } } }, { env: { ...ON, EMAIL_VERIFY_DAILY_CAP: '1' }, now: NOW * 1000 })
  assert.equal(c3.zb.length, 1); assert.equal(scanCalls, 0)
})
