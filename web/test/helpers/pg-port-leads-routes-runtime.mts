// Postgres port, leads routes (#354 area 2, first slice): the real evidence, source-metrics, page-signals and
// domain-review handlers, run on SQLite, on SQLite with the raw handle trapped, and on a Postgres-only fixture, from the
// same seed. Every response and every row the writes leave must be identical across the engines.
// On Postgres there is no SQLite at all: getScanDb is trapped, so a route still reaching for the raw handle fails.
// Malformed and foreign input is part of the scenario: each case must be refused (fail closed) and is recorded in the
// compared output, so a refusal that differs by engine fails too.
// Synthetic data only; any outbound fetch fails the run (the page-signals leads have no https page to read).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser, trapScanDb } from './tenant-route-db.ts'
import { getDb, setDb, sqliteDb, pgDb, type Db } from '../../lib/db/client.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { runPgMigrations } from '../../lib/db/migrate-pg.ts'
import { domainReviewFor } from '../../lib/outreach/domain-review.ts'
import { PG_URL, freshSchema } from './pg-test.ts'

const fetchCalls: string[] = []
globalThis.fetch = (async (u: unknown) => { fetchCalls.push(String(u)); throw new Error('Unexpected network call') }) as typeof fetch

const evidence = await import('../../app/api/leads/evidence/route.ts')
const sourceMetrics = await import('../../app/api/leads/source-metrics/route.ts')
const pageSignals = await import('../../app/api/leads/page-signals/route.ts')
const domainReview = await import('../../app/api/leads/[lead]/domain-review/route.ts')

const A = { id: 'tenantA_leads', business_name: 'Acme' }, B = { id: 'tenantB_leads', business_name: 'Beta' }
const T0 = 1_790_000_000, FAR = 2_100_000_000
const RECENT = Math.floor(Date.now() / 1000) - 60 // inside the 7-day reply window on both legs
const id = (c: string) => c.repeat(24).slice(0, 24)
const JOB_A = id('a1'), JOB_B = id('b1')
const L = { copy: id('c1'), tampered: id('c2'), expired: id('c3'), purged: id('c4'), review: id('c5'), own: id('c6'), tie: id('c7'), b: id('c8') }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

async function seed(db: Db): Promise<void> {
  for (const [job, t] of [[JOB_A, A.id], [JOB_B, B.id]]) {
    await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, created_at) VALUES (?, ?, 'Seller', 'software', 'Toronto', 'q', ?)", [job, t, T0])
    await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?", [job])
  }
  const copy = async (cid: string, job: string, tenant: string, url: string, title: string, text: string, expires: number, storedSha = sha(text)) =>
    db.run('INSERT INTO lead_evidence_copies (id, tenant_id, job_id, attempt, source_url, canonical_url, title, title_sha256, sha256, text, byte_length, fetched_at, created_at, expires_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [cid, tenant, job, url, url, title, sha(title), storedSha, text, Buffer.byteLength(text), T0, T0, expires])
  await copy('copy-ok', JOB_A, A.id, 'https://n.example/ok', 'Acme hires', 'Acme Roofing is hiring a sales rep.', FAR)
  await copy('copy-bad', JOB_A, A.id, 'https://n.example/bad', 'Acme again', 'Text as received.', FAR, sha('a different text'))
  await copy('copy-old', JOB_A, A.id, 'https://n.example/old', 'Old', 'Old text.', 1_000)
  const lead = async (lid: string, job: string, company: string, extra: { copy?: string; purged?: number; contact?: string; fit?: number; created?: number; failure?: string } = {}) =>
    db.run('INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, contact, created_at, evidence_copy_id, evidence_purged_at, own_fetch_failure, fit) VALUES (?, ?, \'P\', ?, \'Hiring\', \'http://n.example/plain\', 70, ?, ?, ?, ?, ?, ?)',
      [lid, job, company, extra.contact ?? null, extra.created ?? T0, extra.copy ?? null, extra.purged ?? null, extra.failure ?? null, extra.fit ?? null])
  await lead(L.copy, JOB_A, 'Acme Roofing', { copy: 'copy-ok', fit: 5, failure: 'blocked' })
  await lead(L.tampered, JOB_A, 'Acme Two', { copy: 'copy-bad', fit: 2 })
  await lead(L.expired, JOB_A, 'Acme Three', { copy: 'copy-old', created: RECENT })
  await lead(L.purged, JOB_A, 'Acme Four', { purged: T0 + 5 })
  await lead(L.review, JOB_A, 'Acme Five')
  await lead(L.own, JOB_A, 'Acme Six')
  await lead(L.tie, JOB_A, 'Acme Seven')
  await lead(L.b, JOB_B, 'Beta Co', { fit: 4 })
  // Collector runs and credited leads (source metrics): an unobserved counter on one run makes its collector unknown.
  const run = (job: string, attempt: number, c: string, cand: number | null, ver: number | null, ins: number) =>
    db.run("INSERT INTO scan_source_runs (job_id, attempt, collector, status, candidate_count, verified_count, inserted_count) VALUES (?, ?, ?, 'ok', ?, ?, ?)", [job, attempt, c, cand, ver, ins])
  await run(JOB_A, 1, 'adapter:rss', 10, 4, 3); await run(JOB_A, 2, 'adapter:rss', 6, 2, 1)
  await run(JOB_A, 1, 'search:tinyfish', null, 3, 2)
  await run(JOB_B, 1, 'adapter:reddit', 7, 1, 1)
  for (const [lid, c] of [[L.copy, 'adapter:rss'], [L.tampered, 'adapter:rss'], [L.copy, 'search:tinyfish'], [L.expired, 'search:tinyfish'], [L.b, 'adapter:reddit']]) await db.run('INSERT INTO lead_sources (lead_id, collector, attempt) VALUES (?, ?, 1)', [lid, c])
  await db.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES ('m-a', ?, ?, 'pat@acme.test', 'hi', 'bodybodybodybodybody', 'sent')", [A.id, L.copy])
  await db.run("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES ('sq-a', ?, ?, 'm-a', 'pat@acme.test', 'replied')", [A.id, L.copy])
  // Crawled addresses (domain review): L.review needs the user's website check, L.own is on the cited page's own domain
  // (no check needed), L.tie has two addresses read at the same second (the earlier-inserted one is the pick).
  const enr = (lid: string, tenant: string, kind: string, value: string, label: string | null, url: string, at: number) =>
    db.run("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, ?, 'sitecrawl', ?, ?, ?, NULL, ?, '2026-10-01', ?)",
      [`e-${lid.slice(0, 2)}-${kind}-${value}`.slice(0, 60), lid, tenant, kind, value, label, url, at])
  await enr(L.review, A.id, 'email', 'info@acme.test', null, 'https://acme.test/contact', 10)
  await enr(L.review, A.id, 'domain', 'acme.test|evidence_link_domain_label', 'domain-basis-v1:evidence_link_domain_label', 'https://jobs.test/a', 10)
  await enr(L.own, A.id, 'email', 'info@six.test', null, 'https://six.test/contact', 10)
  await enr(L.own, A.id, 'domain', 'six.test|evidence_own_domain', 'domain-basis-v1:evidence_own_domain', 'https://six.test/careers', 10)
  await enr(L.tie, A.id, 'email', 'zed@seven.test', null, 'https://seven.test/contact', 20)
  await enr(L.tie, A.id, 'email', 'amy@seven.test', null, 'https://seven.test/team', 20)
  await enr(L.tie, A.id, 'domain', 'seven.test|name_probe', 'domain-basis-v1:name_probe', 'https://seven.test/', 20)
}

let ip = 0
const req = (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => new NextRequest(`http://localhost${url}`, {
  method, headers: { 'content-type': 'application/json', host: 'localhost', 'x-forwarded-for': `10.56.0.${++ip % 250}`, ...headers },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = (lead: string) => ({ params: Promise.resolve({ lead }) })
type Out = { name: string; status: number; body: unknown }
async function call(name: string, res: Promise<Response>): Promise<Out> {
  const r = await res
  const text = await r.text()
  let body: unknown = text
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  return { name, status: r.status, body }
}

// The binding the user's page showed: computed from the stored evidence rows, as the Leads page does.
async function bindingFor(db: Db, lead: string): Promise<string> {
  const rows = await db.all<{ connector: string; kind: string; value: string; label: string | null; source_url: string; retrieved_at: number }>("SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ? AND ((connector = 'sitecrawl' AND kind IN ('email','domain')) OR (connector = 'user' AND kind = 'domain_review')) ORDER BY insert_seq", [lead])
  const b = domainReviewFor({ id: lead, contact: null }, rows).binding
  assert.ok(b, `${lead}: the fixture needs a website check`)
  return b
}

async function scenario(db: Db): Promise<{ out: Out[]; rows: Record<string, unknown> }> {
  const out: Out[] = []
  const as = async (u: typeof A | null, name: string, res: () => Promise<Response>) => { setUser(u); out.push(await call(name, res())) }
  // evidence: the preserved copy, an integrity mismatch, expired, purged on request, foreign, malformed ids, signed out.
  const ev = (q: string) => () => evidence.GET(req(`/api/leads/evidence${q}`))
  await as(A, 'evidence copy', ev(`?lead_id=${L.copy}`))
  await as(A, 'evidence tampered copy', ev(`?lead_id=${L.tampered}`))
  await as(A, 'evidence expired copy', ev(`?lead_id=${L.expired}`))
  await as(A, 'evidence purged', ev(`?lead_id=${L.purged}`))
  await as(A, 'evidence no copy', ev(`?lead_id=${L.review}`))
  await as(B, 'evidence other tenant', ev(`?lead_id=${L.copy}`))
  await as(B, 'evidence other tenant purged', ev(`?lead_id=${L.purged}`))
  for (const [n, q] of [['missing', ''], ['empty', '?lead_id='], ['short', '?lead_id=abc'], ['uppercase', `?lead_id=${L.copy.toUpperCase()}`], ['long', `?lead_id=${L.copy}0`], ['sql', `?lead_id=${encodeURIComponent("' OR 1=1 --")}`], ['non-utf8', '?lead_id=%FF%FE'], ['repeated', `?lead_id=zz&lead_id=${L.copy}`]]) await as(A, `evidence malformed ${n}`, ev(q))
  await as(null, 'evidence signed out', ev(`?lead_id=${L.copy}`))
  // source metrics: per tenant, never the other tenant's collectors.
  await as(A, 'source metrics A', () => sourceMetrics.GET())
  await as(B, 'source metrics B', () => sourceMetrics.GET())
  await as({ id: 'tenantC_empty', business_name: 'C' }, 'source metrics empty tenant', () => sourceMetrics.GET())
  await as(null, 'source metrics signed out', () => sourceMetrics.GET())
  // page signals: the lead read; no https page, so no fetch.
  const ps = (q: string) => () => pageSignals.GET(req(`/api/leads/page-signals${q}`))
  await as(A, 'page signals', ps(`?lead_id=${L.copy}`))
  await as(B, 'page signals other tenant', ps(`?lead_id=${L.copy}`))
  for (const [n, q] of [['missing', ''], ['short', '?lead_id=1'], ['non-hex', `?lead_id=${'g'.repeat(24)}`], ['non-utf8', '?lead_id=%C3%28']]) await as(A, `page signals malformed ${n}`, ps(q))
  await as(null, 'page signals signed out', ps(`?lead_id=${L.copy}`))
  // domain review: every malformed body is a 400 before any read; foreign, not needed and stale bindings record nothing.
  const bind = await bindingFor(db, L.review)
  const dr = (lead: string, body: unknown, headers?: Record<string, string>) => () => domainReview.POST(req(`/api/leads/${lead}/domain-review`, 'POST', body, headers), ctx(lead))
  await as(null, 'review signed out', dr(L.review, { action: 'confirm', binding: bind }))
  await as(A, 'review bad origin', dr(L.review, { action: 'confirm', binding: bind }, { origin: 'https://evil.example' }))
  await as(A, 'review not json', dr(L.review, { action: 'confirm', binding: bind }, { 'content-type': 'text/plain' }))
  await as(A, 'review malformed lead id', dr('not-a-lead', { action: 'confirm', binding: bind }))
  await as(A, 'review broken json', dr(L.review, '{"action":'))
  for (const [n, body] of [['null body', null], ['list body', [1, 2]], ['number body', 7], ['action missing', { binding: bind }], ['action number', { action: 1, binding: bind }], ['action list', { action: ['confirm'], binding: bind }],
    ['action object', { action: { confirm: true }, binding: bind }], ['action case', { action: 'CONFIRM', binding: bind }], ['action null', { action: null }], ['binding missing', { action: 'confirm' }], ['binding null', { action: 'confirm', binding: null }],
    ['binding number', { action: 'confirm', binding: 12345 }], ['binding list', { action: 'confirm', binding: [bind] }], ['binding object', { action: 'confirm', binding: { v: bind } }], ['binding short', { action: 'confirm', binding: bind.slice(1) }],
    ['binding uppercase', { action: 'confirm', binding: bind.toUpperCase() }], ['binding huge', { action: 'confirm', binding: 'a'.repeat(100_000) }]] as [string, unknown][]) await as(A, `review ${n}`, dr(L.review, body))
  await as(B, 'review other tenant confirm', dr(L.review, { action: 'confirm', binding: bind }))
  await as(A, 'review unknown lead', dr(id('c9'), { action: 'confirm', binding: bind }))
  await as(A, 'review not required', dr(L.own, { action: 'confirm', binding: bind }))
  await as(A, 'review stale binding', dr(L.review, { action: 'confirm', binding: 'f'.repeat(64) }))
  const extra = { action: 'confirm', binding: bind, admin: true, tenant: B.id }
  await as(A, 'review confirm (extra keys ignored)', dr(L.review, extra))
  await as(A, 'review confirm replay', dr(L.review, { action: 'confirm', binding: bind }))
  const afterConfirm = await db.all("SELECT lead_id, tenant_id, connector, kind, value, label, source_url FROM lead_enrichments WHERE connector = 'user' ORDER BY lead_id")
  await as(B, 'review other tenant withdraw', dr(L.review, { action: 'withdraw' }))
  const afterForeignWithdraw = await db.all("SELECT lead_id, kind FROM lead_enrichments WHERE connector = 'user' ORDER BY lead_id")
  await as(A, 'review withdraw', dr(L.review, { action: 'withdraw', binding: 12 }))
  await as(A, 'review withdraw replay', dr(L.review, { action: 'withdraw' }))
  // two addresses read at the same second: the earlier-inserted one is the pick on both engines
  const tieBind = await bindingFor(db, L.tie)
  await as(A, 'review tie confirm', dr(L.tie, { action: 'confirm', binding: tieBind }))
  setUser(null)
  const rows = {
    afterConfirm, afterForeignWithdraw,
    userRows: await db.all("SELECT lead_id, tenant_id, kind, value, label, source_url FROM lead_enrichments WHERE connector = 'user' ORDER BY lead_id"),
    crawled: await db.all("SELECT lead_id, tenant_id, kind, value, label FROM lead_enrichments WHERE connector = 'sitecrawl' ORDER BY lead_id, kind, value"),
    leads: await db.all('SELECT id, evidence_copy_id, evidence_purged_at FROM leads ORDER BY id'),
  }
  return { out, rows }
}

const by = (out: Out[], n: string) => { const o = out.find(x => x.name === n); assert.ok(o, n); return o }
function check(r: { out: Out[]; rows: Record<string, unknown> }, engine: string) {
  const o = (n: string) => by(r.out, n)
  const st = (n: string) => o(n).status
  const copy = o('evidence copy').body as Record<string, unknown>
  assert.equal(st('evidence copy'), 200)
  assert.deepEqual([copy.lead_id, copy.text, copy.integrity, copy.attempt, copy.expires_at, copy.own_fetch_failure], [L.copy, 'Acme Roofing is hiring a sales rep.', 'ok', 1, FAR, 'blocked'], `${engine}: the preserved copy`)
  assert.equal((o('evidence tampered copy').body as { integrity: string }).integrity, 'mismatch', `${engine}: a hash mismatch is shown as such`)
  assert.equal(st('evidence expired copy'), 404, `${engine}: an expired copy is absent`)
  assert.deepEqual([st('evidence purged'), (o('evidence purged').body as { purged_at: number }).purged_at], [410, T0 + 5])
  assert.equal(st('evidence no copy'), 404)
  assert.deepEqual([st('evidence other tenant'), st('evidence other tenant purged')], [404, 404], `${engine}: another tenant's lead is not found`)
  for (const n of ['missing', 'empty', 'short', 'uppercase', 'long', 'sql', 'non-utf8', 'repeated']) assert.equal(st(`evidence malformed ${n}`), 404, `${engine}: evidence ${n}`)
  assert.equal(st('evidence signed out'), 401)
  const metrics = (n: string) => (o(n).body as { rows: Record<string, unknown>[] }).rows
  assert.deepEqual(metrics('source metrics A').map(m => [m.collector, m.jobs, m.candidates, m.verified, m.inserted, m.leads, m.strong_fit, m.outreach_started, m.replied, m.recent_leads]),
    [['adapter:rss', 1, 16, 6, 4, 2, 1, 1, 1, 0], ['search:tinyfish', 1, null, 3, 2, 2, 1, 1, 1, 1]], `${engine}: per-collector funnel; an unobserved counter is unknown, not zero`)
  assert.deepEqual(metrics('source metrics B').map(m => m.collector), ['adapter:reddit'], `${engine}: B sees only its own collectors`)
  assert.deepEqual(metrics('source metrics empty tenant'), [])
  assert.equal(st('source metrics signed out'), 401)
  assert.deepEqual([st('page signals'), (o('page signals').body as { pages: unknown[] }).pages], [200, []])
  assert.equal(st('page signals other tenant'), 404)
  for (const n of ['missing', 'short', 'non-hex', 'non-utf8']) assert.equal(st(`page signals malformed ${n}`), 400, `${engine}: page signals ${n}`)
  assert.equal(st('page signals signed out'), 401)
  assert.deepEqual([st('review signed out'), st('review bad origin'), st('review not json'), st('review malformed lead id'), st('review broken json')], [401, 403, 403, 404, 400])
  for (const n of ['null body', 'list body', 'number body', 'action missing', 'action number', 'action list', 'action object', 'action case', 'action null', 'binding missing', 'binding null', 'binding number', 'binding list', 'binding object', 'binding short', 'binding uppercase', 'binding huge']) assert.equal(st(`review ${n}`), 400, `${engine}: review ${n}`)
  assert.deepEqual([st('review other tenant confirm'), st('review unknown lead')], [404, 404])
  assert.equal(st('review not required'), 409)
  assert.deepEqual([st('review stale binding'), (o('review stale binding').body as { stale: boolean }).stale], [409, true])
  assert.deepEqual([o('review confirm (extra keys ignored)').body, o('review confirm replay').body], [{ status: 'confirmed', domain: 'acme.test' }, { status: 'confirmed', domain: 'acme.test' }])
  const rows = r.rows as { afterConfirm: { lead_id: string; tenant_id: string }[]; afterForeignWithdraw: unknown[]; userRows: { lead_id: string; value: string }[] }
  assert.deepEqual(rows.afterConfirm.map(x => [x.lead_id, x.tenant_id]), [[L.review, A.id]], `${engine}: one review row, in A's tenant, after a replayed confirm`)
  assert.deepEqual(rows.afterForeignWithdraw, [{ lead_id: L.review, kind: 'domain_review' }], `${engine}: another tenant's withdraw removed nothing`)
  assert.deepEqual([st('review other tenant withdraw'), o('review withdraw').body, o('review withdraw replay').body], [404, { status: 'withdrawn' }, { status: 'withdrawn' }])
  assert.deepEqual(o('review tie confirm').body, { status: 'confirmed', domain: 'seven.test' })
  assert.deepEqual(rows.userRows.map(x => [x.lead_id, x.value]), [[L.tie, 'seven.test']], `${engine}: the withdraw removed the review; the tie confirm recorded one`)
  assert.deepEqual(fetchCalls, [], `${engine}: no outbound fetch`)
}

async function onSqlite(trap: boolean) {
  const lite = new Database(':memory:')
  migrateAllSqlite(lite)
  setScanDb(lite) // getScanDb and getDb both see this store, as in the app
  if (trap) trapScanDb()
  await seed(sqliteDb(lite))
  return scenario(sqliteDb(lite))
}

test('leads routes on SQLite: evidence, source metrics, page signals and domain review', async () => {
  check(await onSqlite(false), 'sqlite')
})

// The same scenario with the raw handle trapped (getScanDb throws; getDb still serves the store). Runs without Postgres;
// before the port every one of these routes failed here.
test('leads routes with getScanDb trapped: nothing needs the raw SQLite handle', async () => {
  check(await onSqlite(true), 'sqlite, raw handle trapped')
})

// The Postgres leg. Defined after the SQLite-only tests on purpose: test/pg-fixture-honesty.test.ts allows no
// setScanDb(fixture) in the source after the first setDb(pg...), so the SQLite fixtures stay above this line.
async function onPg() {
  const s = await freshSchema()
  const pg = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 3 })
  try {
    await runPgMigrations(pg.pool)
    trapScanDb() // getScanDb() now throws: Postgres deployments have no raw SQLite handle
    setDb(pg)
    assert.equal((await getDb()).kind, 'pg', 'engine canary: the route-facing store IS Postgres')
    await seed(pg)
    return await scenario(pg)
  } finally { await pg.close(); await s.drop() }
}

test('leads routes on a Postgres-only fixture: identical responses and writes; no SQLite handle anywhere', { skip: PG_URL ? false : 'DAZL_TEST_PG_URL not set' }, async () => {
  const sqlite = await onSqlite(false)
  const pg = await onPg()
  check(pg, 'pg')
  for (const [i, o] of sqlite.out.entries()) assert.deepEqual(pg.out[i], o, `${o.name}: Postgres answered differently`)
  assert.deepEqual(pg.rows, sqlite.rows, 'rows after the writes differ')
  console.log('LEADS ROUTES IDENTICAL ON POSTGRES')
})
