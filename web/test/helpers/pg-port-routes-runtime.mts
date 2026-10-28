// Postgres port, batch 1 (docs/PLATFORM.md "Postgres port"): the real handlers of every route this batch moved to the
// Db layer, run on SQLite and on Postgres from the same seed, two tenants. Every response and every row the writes
// leave behind must be identical on both engines. On Postgres the raw SQLite handle is a trap: getScanDb() throws and
// DB_PATH points at a file that cannot be opened, so a route that still reached for SQLite would fail here.
// Synthetic data only; any outbound fetch fails the run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { setDb, sqliteDb, pgDb, type Db } from '../../lib/db/client.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { runPgMigrations } from '../../lib/db/migrate-pg.ts'
import { PG_URL, freshSchema } from './pg-test.ts'
import * as Legacy from '../../lib/scan/store.ts'

process.env.DB_PATH = '/nonexistent-dazl-dir/app.db' // getAuthDb() cannot open: any raw access fails
process.env.DAZL_TRIAL_ANTHROPIC_KEY = 'sk-ant-test-fixture-not-a-key' // makes the trial path run; never sent anywhere

const jobs = await import('../../app/api/scan/jobs/route.ts')
const latest = await import('../../app/api/scan/latest/route.ts')
const cancel = await import('../../app/api/scan/cancel/route.ts')
const confirm = await import('../../app/api/leads/[lead]/confirm/route.ts')
const quarantine = await import('../../app/api/leads/[lead]/quarantine/route.ts')
const exportRoute = await import('../../app/api/leads/export/route.ts')
const campaign = await import('../../app/api/campaigns/[id]/route.ts')
const profile = await import('../../app/api/settings/profile/route.ts')
const usage = await import('../../app/api/usage/route.ts')

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call: ${String(u)}`) }) as typeof fetch

const A = 'a'.repeat(32), B = 'b'.repeat(32)
// This month (the usage route counts this month's scans); fixture rows share created_at seconds, so ties must resolve the same way.
const now0 = new Date()
const T = Math.floor(Date.UTC(now0.getUTCFullYear(), now0.getUTCMonth(), 1) / 1000) + 60
const STARTED = Math.floor(Date.now() / 1000) - 5
// Ids per seed. 'scrambled': ids out of insertion order, so insertion order and id order disagree on every tie.
// 'aligned': ids ascend in insertion order, so they agree, and the two engines must answer identically.
type Ids = ReturnType<typeof makeIds>
function makeIds(aligned: boolean) {
  return {
    J: aligned ? { aPending: 'a1'.repeat(12), aDone: 'a2'.repeat(12), aEmpty: 'a3'.repeat(12), bDone: 'b1'.repeat(12) }
      : { aPending: 'a3'.repeat(12), aDone: 'a1'.repeat(12), aEmpty: 'a2'.repeat(12), bDone: 'b1'.repeat(12) },
    L: aligned ? { second: '01'.repeat(12), first: '02'.repeat(12), review: '03'.repeat(12), third: '04'.repeat(12), bLead: 'b9'.repeat(12) }
      : { second: 'f1'.repeat(12), first: '0e'.repeat(12), review: '5d'.repeat(12), third: '7c'.repeat(12), bLead: 'b9'.repeat(12) },
    E: aligned ? ['e1', 'e2'] : ['e2', 'e1'], // insertion order of the two equally ranked people
    M: aligned ? ['m1', 'm2'] : ['m2', 'm1'], // insertion order of the two same-second messages
  }
}
const req = (url: string, method = 'GET', body?: unknown) => new NextRequest(`https://app.dazl.test${url}`, {
  method, headers: { 'content-type': 'application/json', host: 'app.dazl.test', origin: 'https://app.dazl.test', 'x-forwarded-for': '203.0.113.7' },
  body: body === undefined ? undefined : JSON.stringify(body) })
const ctx = <T extends object>(p: T) => ({ params: Promise.resolve(p) })

async function seed(db: Db, { J, L, E, M }: Ids): Promise<void> {
  const run = (sql: string, p: (string | number | null)[] = []) => db.run(sql, p)
  await run("INSERT INTO users (id, email, password_hash, salt, business_name, sells, website, created_at) VALUES (?, 'a@example.test', 'h', 's', 'Acme Co', 'dental software', 'https://acme.example', ?)", [A, T])
  await run("INSERT INTO users (id, email, password_hash, salt, business_name, created_at) VALUES (?, 'b@example.test', 'h', 's', 'Beta', ?)", [B, T])
  await run("INSERT INTO tenant_plans (tenant_id, plan, subscription_status) VALUES (?, 'pro', 'past_due')", [A])
  await run("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at, created_at) VALUES (?, 'anthropic', 'x', '1234', ?, ?)", [A, T, T])
  const job = async (id: string, user: string, query: string, at: number, icp: string | null = null) => {
    await run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, created_at) VALUES (?, ?, ?, 'dental', 'Toronto', ?, ?, ?)", [id, user, query.slice(0, 150), query, icp, at])
  }
  // Inserted out of id order, within one second: insertion order must decide ties on SQLite, as before the port.
  await job(J.aPending, A, 'Pending search', T + 50)
  await job(J.aDone, A, 'Dental clinics hiring', T + 50, JSON.stringify({ who: ['Practice manager'] }))
  await job(J.aEmpty, A, 'Nothing found', T + 50)
  await job(J.bDone, B, 'Beta search', T + 40)
  for (const id of [J.aDone, J.bDone]) await run("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ? WHERE id = ?", [T + 51, id])
  const lead = async (id: string, jobId: string, company: string, extra: { review?: string; confidence?: number } = {}) => run(
    "INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, fit, review_reason, confidence, evidence_excerpt, created_at) VALUES (?, ?, 'Pat', ?, 'Hiring a practice manager', ?, 70, 4, ?, ?, 'We are hiring', ?)",
    [id, jobId, company, `https://${company.toLowerCase().replace(/\W/g, '')}.example/jobs`, extra.review ?? null, extra.confidence ?? null, T + 60])
  await lead(L.second, J.aDone, 'Second Dental')
  await lead(L.first, J.aDone, 'First Dental')
  await lead(L.review, J.aDone, 'Review Dental', { review: 'quote_not_found' })
  await lead(L.third, J.aDone, 'Third Dental')
  await lead(L.bLead, J.bDone, 'Beta Lead', { review: 'quote_not_found' })
  for (const id of [J.aDone, J.bDone]) await run("UPDATE scan_jobs SET status = 'done', finished_at = ?, candidates = 4, verified = 3, needs_review = 1, dropped = 0, claimed_at = NULL WHERE id = ?", [T + 70, id])
  await run("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?", [J.aEmpty])
  await run("UPDATE scan_jobs SET status = 'failed', error = 'no_candidates', candidates = 0, finished_at = ? WHERE id = ?", [T + 80, J.aEmpty])
  await run('INSERT INTO scan_run_report (job_id, attempt, report) VALUES (?, 1, ?)', [J.aEmpty, JSON.stringify({ extraction: { reason: 'none_returned', results: 8, requested: 5, fetched: 4, fetch_failed: 1, fetched_unused: 0, fetched_too_short: 0, offered: 6, page_texts_given: 4, snippet_only: 2, job_pages_fetched: 0 } })])
  // Two people for one lead, equal rank: the first stored must win on both engines.
  for (const [id, who] of [[E[0], 'Dana Lee, Practice Manager'], [E[1], 'Eli Novak, Practice Manager']]) {
    await run("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES (?, ?, ?, 'sitecrawl', 'person', ?, ?, 'https://firstdental.example/team', '2026-10-01', ?)", [id, L.first, A, who, who, T])
  }
  await run("INSERT INTO lead_sources (lead_id, collector, attempt) VALUES (?, 'news:gdelt', 1)", [L.second])
  for (const [id, lead, at] of [[M[0], L.second, T + 90], [M[1], L.first, T + 90], ['m3', L.third, T + 95]] as const) {
    await run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, created_at) VALUES (?, ?, ?, 'pat@dental.example', 'Hello', 'A body that is long enough to pass.', ?)", [id, A, lead, at])
  }
  await run("INSERT INTO trial_scans (tenant_id, job_id, ip_hash) VALUES (?, ?, 'h')", [B, J.bDone])
}

type Out = { name: string; status: number; body: unknown }
async function call(name: string, res: Response | Promise<Response>): Promise<Out> {
  const r = await res
  const text = await r.text()
  let body: unknown = text
  try { body = JSON.parse(text) } catch { /* CSV */ }
  return { name, status: r.status, body }
}

// Times the writes take from the clock are compared as "set or not"; everything else exactly.
const shape = (rows: Record<string, unknown>[]) => rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, /_at$/.test(k) && typeof v === 'number' && v >= STARTED ? 'now' : v])))

async function scenario(db: Db, { J, L }: Ids): Promise<{ out: Out[]; rows: unknown }> {
  const out: Out[] = []
  setUser({ id: A, business_name: 'Acme Co' })
  out.push(await call('jobs', jobs.GET()))
  out.push(await call('latest', latest.GET()))
  out.push(await call('campaign', campaign.GET(new Request('https://x'), ctx({ id: J.aDone }))))
  out.push(await call('campaign empty', campaign.GET(new Request('https://x'), ctx({ id: J.aEmpty }))))
  out.push(await call('export', exportRoute.GET(req(`/api/leads/export?job_id=${J.aDone}`))))
  out.push(await call('export all', exportRoute.GET(req('/api/leads/export'))))
  out.push(await call('profile', profile.GET()))
  out.push(await call('profile save', profile.POST(req('/api/settings/profile', 'POST', { sells: '  dental scheduling ', business_name: '  Acme   Dental Co ', buyer: null }))))
  out.push(await call('usage A', usage.GET(req('/api/usage'))))
  out.push(await call('confirm', confirm.POST(req(`/api/leads/${L.review}/confirm`, 'POST', {}), ctx({ lead: L.review }))))
  out.push(await call('confirm again', confirm.POST(req(`/api/leads/${L.review}/confirm`, 'POST', {}), ctx({ lead: L.review }))))
  out.push(await call('quarantine', quarantine.POST(req(`/api/leads/${L.third}/quarantine`, 'POST', { reason: 'wrong\ncompany' }), ctx({ lead: L.third }))))
  out.push(await call('export after quarantine', exportRoute.GET(req(`/api/leads/export?job_id=${J.aDone}`))))
  out.push(await call('cancel', cancel.POST(req('/api/scan/cancel', 'POST', { job_id: J.aPending }))))
  out.push(await call('cancel finished', cancel.POST(req('/api/scan/cancel', 'POST', { job_id: J.aDone }))))
  // Tenant B on tenant A's ids: refused, nothing of A's returned or changed.
  setUser({ id: B, business_name: 'Beta' })
  out.push(await call('B campaign of A', campaign.GET(new Request('https://x'), ctx({ id: J.aDone }))))
  out.push(await call('B export of A', exportRoute.GET(req(`/api/leads/export?job_id=${J.aDone}`))))
  out.push(await call('B unconfirm A', confirm.DELETE(req(`/api/leads/${L.review}/confirm`, 'DELETE'), ctx({ lead: L.review }))))
  out.push(await call('B release A', quarantine.DELETE(req(`/api/leads/${L.third}/quarantine`, 'DELETE'), ctx({ lead: L.third }))))
  out.push(await call('B cancel A', cancel.POST(req('/api/scan/cancel', 'POST', { job_id: J.aDone }))))
  out.push(await call('B jobs', jobs.GET()))
  out.push(await call('B usage', usage.GET(req('/api/usage'))))
  out.push(await call('B profile', profile.GET()))
  setUser({ id: A, business_name: 'Acme Co' })
  out.push(await call('unconfirm', confirm.DELETE(req(`/api/leads/${L.review}/confirm`, 'DELETE'), ctx({ lead: L.review }))))
  out.push(await call('release', quarantine.DELETE(req(`/api/leads/${L.third}/quarantine`, 'DELETE'), ctx({ lead: L.third }))))
  const rows = {
    users: await db.all('SELECT id, business_name, sells, website, buyer_profile FROM users ORDER BY id'),
    leads: shape(await db.all('SELECT id, review_reason, human_confirmed_at, human_confirmed_from, quarantined_at, quarantine_reason FROM leads ORDER BY id')),
    jobs: shape(await db.all('SELECT id, status, error, attempts, finished_at FROM scan_jobs ORDER BY id')),
  }
  return { out, rows }
}

async function onSqlite(ids: Ids) {
  const lite = new Database(':memory:')
  migrateAllSqlite(lite)
  setScanDb(lite)
  await seed(sqliteDb(lite), ids)
  return { lite, ...await scenario(sqliteDb(lite), ids) }
}

async function onPg(ids: Ids) {
  const s = await freshSchema()
  const pg = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 3 })
  try {
    await runPgMigrations(pg.pool)
    setScanDb(null as unknown as Database.Database) // getScanDb() now throws 'test database unset'
    setDb(pg)
    await seed(pg, ids)
    return await scenario(pg, ids)
  } finally { await pg.close(); await s.drop() }
}

const jobIds = (o: Out) => (o.body as { jobs: { id: string }[] }).jobs.map(j => j.id)
const csvCompanies = (o: Out) => String(o.body).split('\n').slice(1).filter(Boolean).map(l => l.split(',')[0])
const campaignLeads = (o: Out) => (o.body as { leads: { id: string }[] }).leads.map(l => l.id)
const campaignMessages = (o: Out) => (o.body as { messages: { id: string }[] }).messages.map(m => m.id)

test('batch 1 routes on SQLite answer exactly as the raw store did, including same-second ties', async () => {
  const ids = makeIds(false), { J, L } = ids
  const { lite, out } = await onSqlite(ids)
  const by = (n: string) => out.find(o => o.name === n)!
  assert.deepEqual(jobIds(by('jobs')), [J.aEmpty, J.aDone, J.aPending], 'same-second jobs newest-inserted first')
  assert.deepEqual(jobIds(by('jobs')), Legacy.listJobs(lite, A).map(j => j.id), 'as the raw store listed them')
  assert.equal((by('latest').body as { query: string }).query, Legacy.latestQueryJob(lite, A)!.query)
  assert.deepEqual(campaignLeads(by('campaign')), [L.second, L.first, L.review, L.third], 'campaign leads in insertion order')
  assert.deepEqual(campaignMessages(by('campaign')), ['m3', 'm1', 'm2'], 'newest first, same-second ties newest-inserted first')
  assert.match((by('campaign empty').body as { job: { empty_reason: string } }).job.empty_reason, /^The search returned 8 results/)
  assert.deepEqual(csvCompanies(by('export')), ['Second Dental', 'First Dental', 'Review Dental', 'Third Dental'], 'export rows in insertion order')
  assert.deepEqual(csvCompanies(by('export')), Legacy.exportLeads(lite, A, J.aDone).map(r => (r as { company: string }).company), 'as the raw store exported them')
  const csv = String(by('export').body).split('\n')
  assert.match(csv.find(l => l.startsWith('First Dental'))!, /Dana Lee/, 'the first stored person wins a ranking tie')
  assert.match(csv.find(l => l.startsWith('Second Dental'))!, /GDELT/)
  assert.ok(!String(by('export after quarantine').body).includes('Third Dental'))
  assert.deepEqual([by('confirm').status, by('confirm again').status, by('quarantine').status, by('cancel').status, by('cancel finished').status], [200, 404, 200, 200, 409])
  assert.deepEqual([by('B campaign of A').status, by('B unconfirm A').status, by('B release A').status, by('B cancel A').status], [404, 404, 404, 404])
  assert.ok(!String(by('B export of A').body).includes('Dental'))
  assert.deepEqual(jobIds(by('B jobs')), [J.bDone])
  assert.deepEqual(by('usage A').body, { plan: 'pro', scans_used: 2, scan_limit: null, has_key: true, billing_status: 'past_due', trial: null })
  assert.deepEqual((by('B usage').body as { trial: unknown }).trial, { funded: true, remaining: 2, cap: 3 })
  assert.deepEqual(by('profile save').body, { ok: true, sells: 'dental scheduling', website: 'https://acme.example', business_name: 'Acme Dental Co', buyer: null })
  assert.deepEqual([by('unconfirm').status, by('release').status], [200, 200])
})

test('batch 1 routes: identical responses and writes on SQLite and Postgres; Postgres never touches the SQLite handle', { skip: PG_URL ? false : 'DAZL_TEST_PG_URL not set' }, async () => {
  const ids = makeIds(true)
  const sqlite = await onSqlite(ids)
  const pg = await onPg(ids)
  for (const [i, o] of sqlite.out.entries()) assert.deepEqual(pg.out[i], o, `${o.name}: Postgres answered differently`)
  assert.deepEqual(pg.rows, sqlite.rows, 'rows after the writes differ')
  console.log('BATCH1 ROUTES IDENTICAL')
})

// The tracked gap (lib/db/order.ts, PG_INSERTION_ORDER_GAPS): Postgres has no insertion order, so same-second ties
// fall back to id order there. Pinned so it cannot change unnoticed; the fix is an insertion-order column.
test('Postgres insertion-order gap: same-second ties order by id on Postgres', { skip: PG_URL ? false : 'DAZL_TEST_PG_URL not set' }, async () => {
  const ids = makeIds(false), { J, L } = ids
  const pg = await onPg(ids)
  const by = (n: string) => pg.out.find(o => o.name === n)!
  assert.deepEqual(jobIds(by('jobs')), [J.aPending, J.aEmpty, J.aDone], 'id order, not insertion order')
  assert.deepEqual(campaignLeads(by('campaign')), [L.first, L.review, L.third, L.second])
  assert.deepEqual(campaignMessages(by('campaign')), ['m3', 'm2', 'm1'])
  assert.match(String(by('export').body).split('\n').find(l => l.startsWith('First Dental'))!, /Eli Novak/, 'the lower id wins the ranking tie')
})
