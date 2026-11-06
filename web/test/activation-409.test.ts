// #409: time-to-value and drop-off of the website-first onboarding journey (lib/scan/activation.ts). Pure mapping and
// funnel tests, the journey read on a real SQLite store (stages, tenant isolation, every hold that is not a verified
// lead, malformed rows, an unreadable store), the deployment report, and the real route handlers in their own process
// (test/helpers/activation-route-runtime.mts). Synthetic rows only; no network, no key, no spend.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb, type Db } from '../lib/db/client.ts'
import { record } from '../lib/audit.ts'
import { activationOf, activationReport, formatActivation, readActivation, REPORT_MAX, siteReadOutcome, SITE_READ_ACTION, STAGES, summarize, type Stage } from '../lib/scan/activation.ts'

const at = (o: Partial<Record<Stage, number | null>>) => Object.fromEntries(STAGES.map(s => [s, o[s] ?? null])) as Record<Stage, number | null>

test('siteReadOutcome: every answer of the read maps to a path, a result and a reason code; malformed answers are errors with reason unknown', () => {
  assert.deepEqual(siteReadOutcome({ icp: {}, source: 's', sells: 'x', funded: 'own' }, { keyed: true }), { path: 'own_key', result: 'profile', reason: null })
  assert.deepEqual(siteReadOutcome({ icp: {}, source: 's', sells: 'x', funded: 'trial' }, { keyed: false }), { path: 'trial', result: 'profile', reason: null })
  assert.deepEqual(siteReadOutcome({ icp: {}, source: 's', sells: 'x' }, { keyed: true }), { path: 'own_key', result: 'profile', reason: null })
  for (const why of ['not_configured', 'not_in_allowlist', 'account_total_cap', 'read_failed', 'site_reads_used'])
    assert.deepEqual(siteReadOutcome({ free: true, facts: [], trial: why }, { keyed: false }), { path: 'free', result: 'facts', reason: why })
  assert.deepEqual(siteReadOutcome({ free: true, facts: [] }, { keyed: false, ineligible: true }), { path: 'free', result: 'facts', reason: 'workspace_not_eligible' })
  assert.deepEqual(siteReadOutcome({ free: true, facts: [] }, { keyed: false }), { path: 'free', result: 'facts', reason: 'not_configured' })
  for (const error of ['js_only', 'blocked', 'timeout', 'not_html', 'key_rejected', 'spend_limit'])
    assert.deepEqual(siteReadOutcome({ error }, { keyed: error === 'spend_limit' }), { path: error === 'spend_limit' ? 'own_key' : 'free', result: 'error', reason: error })
  // Malformed: wrong types, missing keys, prose or huge values never reach the audit trail as text.
  for (const bad of [null, undefined, [], 'ok', 42, true, {}, { icp: null }, { icp: 'x' }, { free: 'true' }])
    assert.equal(siteReadOutcome(bad, { keyed: false }).result, 'error', JSON.stringify(bad) ?? 'undefined')
  for (const e of [{}, [], 7, 'Has Spaces', 'x'.repeat(100), 'ünïcode', '\u0000', null])
    assert.equal(siteReadOutcome({ error: e }, { keyed: false }).reason, 'unknown', JSON.stringify(e))
  assert.equal(siteReadOutcome({ free: true, trial: { evil: 1 } }, { keyed: false }).reason, 'unknown')
  assert.equal(siteReadOutcome({ free: true, trial: 'sk-ant-api03-secret-looking' }, { keyed: false }).reason, 'unknown')
})

test('activationOf: the drop-off is the first stage without a row; time-to-value only from sign-up to the first verified lead, never negative', () => {
  const all = activationOf('t', at({ signed_up: 100, read_site: 160, saved_offer: 200, started_scan: 300, verified_lead: 1000 }))
  assert.equal(all.dropped_at, null); assert.equal(all.ttv_s, 900)
  for (let i = 0; i < STAGES.length; i++) {
    const o = at(Object.fromEntries(STAGES.slice(0, i).map((s, k) => [s, 100 + k])))
    assert.equal(activationOf('t', o).dropped_at, STAGES[i])
  }
  assert.equal(activationOf('t', at({ signed_up: 100, started_scan: 300, verified_lead: 400 })).dropped_at, 'read_site', 'a later stage without an earlier one: the drop-off is still the first missing stage')
  assert.equal(activationOf('t', at({ signed_up: 100, started_scan: 300, verified_lead: 400 })).ttv_s, 300)
  assert.equal(activationOf('t', at({ signed_up: 1000, read_site: 1, saved_offer: 1, started_scan: 1, verified_lead: 500 })).ttv_s, null, 'clock skew: unknown, never a fast activation')
  assert.equal(activationOf('t', at({ verified_lead: 500 })).ttv_s, null, 'no sign-up time: unknown')
})

function store() {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  const ws = (id: string, createdAt: number) => {
    raw.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt, created_at) VALUES (?, ?, 'n', 'b', 'x', 'y', ?)").run(id, `${id}@example.com`, createdAt)
    raw.prepare("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'b', 'personal', ?, ?)").run(id, id, createdAt)
  }
  const job = (id: string, tenant: string, createdAt: number) => raw.prepare("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, created_at) VALUES (?, ?, 'running', 'b', 'i', 'l', ?)").run(id, tenant, createdAt)
  let n = 0
  const lead = (jobId: string, createdAt: number, o: { confidence?: number | null; review_reason?: string | null; quarantined_at?: number | null; fit?: number | null; intent?: number | null } = {}) => {
    const id = `lead-${++n}`
    raw.prepare('INSERT INTO leads (id, scan_job_id, company, signal, source_url, created_at, confidence, review_reason, quarantined_at, fit, intent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, jobId, `Co ${n}`, 'raised a seed round', `https://press.example/${n}`, createdAt, o.confidence === undefined ? 80 : o.confidence, o.review_reason ?? null, o.quarantined_at ?? null, o.fit ?? null, o.intent ?? null)
    return id
  }
  const read = (tenant: string, when: number, summary: Record<string, unknown>) => record(db, { tenantId: tenant, actorId: tenant, action: SITE_READ_ACTION, resourceType: 'website', summary }, when)
  return { raw, db, ws, job, lead, read }
}

test('readActivation: stages from durable rows; only a verified, unheld lead is value; another tenant never counts; malformed rows fail closed', async () => {
  const s = store()
  s.ws('A', 1000); s.ws('B', 1000)
  await s.read('A', 1100, { path: 'free', result: 'facts', reason: 'not_in_allowlist' })
  await s.read('A', 1150, { path: 'trial', result: 'profile', reason: null })
  await record(s.db, { tenantId: 'A', actorId: 'A', action: 'settings.changed', resourceType: 'profile' }, 1200)
  await record(s.db, { tenantId: 'A', actorId: 'A', action: 'settings.changed', resourceType: 'sender' }, 1190)   // not the offer
  s.job('jA', 'A', 1300)
  // Every lead that is not value: unverified, in review, rejected, graded not a fit, held by a failed required gate.
  s.lead('jA', 1400, { confidence: null })
  s.lead('jA', 1401, { review_reason: 'counterparty_signal' })
  s.lead('jA', 1402, { quarantined_at: 1500 })
  s.lead('jA', 1403, { fit: 0, intent: null })
  const gated = s.lead('jA', 1404)
  s.raw.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES ('e1', ?, 'A', 'scan:gate', 'gate_failed', 'x', 'https://press.example/g', '2026-11-01', 1)").run(gated)
  // B's rows (a read, a scan, a verified lead) never count for A, and A's never for B.
  await s.read('B', 1001, { path: 'trial', result: 'profile', reason: null })
  s.job('jB', 'B', 1002); s.lead('jB', 1003)
  let a = await readActivation(s.db, s.db, 'A')
  assert.ok(!('unknown' in a))
  assert.deepEqual(a.at, { signed_up: 1000, read_site: 1100, saved_offer: 1200, started_scan: 1300, verified_lead: null })
  assert.equal(a.dropped_at, 'verified_lead'); assert.equal(a.ttv_s, null); assert.equal(a.reads, 2)
  assert.deepEqual(a.first_read, { path: 'free', result: 'facts', reason: 'not_in_allowlist' })
  assert.deepEqual(a.last_read, { path: 'trial', result: 'profile', reason: null })
  // A NULL fit with an intent is graded; fit 0 with an intent is graded too (heldReason's "not a fit" needs both).
  s.lead('jA', 1600, { fit: null, intent: null })
  a = await readActivation(s.db, s.db, 'A')
  assert.ok(!('unknown' in a)); assert.equal(a.at.verified_lead, 1600); assert.equal(a.ttv_s, 600); assert.equal(a.dropped_at, null)
  const b = await readActivation(s.db, s.db, 'B')
  assert.ok(!('unknown' in b)); assert.equal(b.at.verified_lead, 1003); assert.equal(b.dropped_at, 'saved_offer'); assert.equal(b.reads, 1)

  // Malformed stored summaries read as unreadable errors, never crash or vanish.
  s.ws('C', 2000)
  s.raw.prepare("INSERT INTO audit_events (id, tenant_id, actor_id, actor_kind, action, resource_type, decision, summary, at, seq) VALUES ('x1', 'C', 'C', 'user', ?, 'website', 'allowed', 'not json', 2001, 1)").run(SITE_READ_ACTION)
  s.raw.prepare("INSERT INTO audit_events (id, tenant_id, actor_id, actor_kind, action, resource_type, decision, summary, at, seq) VALUES ('x2', 'C', 'C', 'user', ?, 'website', 'allowed', ?, 2002, 2)").run(SITE_READ_ACTION, JSON.stringify({ path: 'moon', result: 'profile' }))
  s.raw.prepare("INSERT INTO audit_events (id, tenant_id, actor_id, actor_kind, action, resource_type, decision, summary, at, seq) VALUES ('x3', 'C', 'C', 'user', ?, 'website', 'allowed', ?, 2003, 3)").run(SITE_READ_ACTION, JSON.stringify({ path: 'trial', result: 'facts', reason: 'Prose that is not a code' }))
  const c = await readActivation(s.db, s.db, 'C')
  assert.ok(!('unknown' in c))
  assert.deepEqual(c.first_read, { path: 'free', result: 'error', reason: 'unreadable' })
  assert.equal(c.reads, 3); assert.deepEqual(c.last_read, { path: 'trial', result: 'facts', reason: 'unknown' })

  // A workspace with no organizations row falls back to its founder's users row; none at all = sign-up not reached.
  s.raw.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt, created_at) VALUES ('D', 'd@example.com', 'n', 'b', 'x', 'y', 3000)").run()
  const d = await readActivation(s.db, s.db, 'D')
  assert.ok(!('unknown' in d)); assert.equal(d.at.signed_up, 3000)
  const ghost = await readActivation(s.db, s.db, 'nobody')
  assert.ok(!('unknown' in ghost)); assert.equal(ghost.dropped_at, 'signed_up')

  // Wrong tenant id types and sizes: unknown, never a query with a coerced id.
  for (const t of [null, undefined, 42, {}, [], '', 'x'.repeat(81)]) assert.ok('unknown' in await readActivation(s.db, s.db, t as never), String(t))
})

test('readActivation: an unreadable store is unknown at the step that failed, reported, and never a drop-off', async () => {
  const s = store(); s.ws('A', 1000)
  const failing = (where: RegExp): Db => new Proxy(s.db, { get(t, k) {
    const v = Reflect.get(t, k)
    if (k !== 'get' && k !== 'all') return typeof v === 'function' ? v.bind(t) : v
    return async (sql: string, p?: unknown[]) => { if (where.test(sql)) throw Object.assign(new Error('disk I/O error'), { code: undefined }); return (v as (q: string, p?: unknown[]) => Promise<unknown>).call(t, sql, p) }
  } })
  assert.deepEqual(await readActivation(failing(/organizations/), s.db, 'A'), { tenant: 'A', unknown: true, where: 'signup' })
  assert.deepEqual(await readActivation(failing(/audit_events/), s.db, 'A'), { tenant: 'A', unknown: true, where: 'audit' })
  assert.deepEqual(await readActivation(s.db, failing(/scan_jobs WHERE/), 'A'), { tenant: 'A', unknown: true, where: 'scans' })
  assert.deepEqual(await readActivation(s.db, failing(/FROM leads/), 'A'), { tenant: 'A', unknown: true, where: 'leads' })
  // A store without lead_enrichments (an older store) is unknown too: the held-gate overlay cannot be checked.
  s.raw.exec('DROP TABLE lead_enrichments')
  const r = await readActivation(s.db, s.db, 'A')
  assert.ok('unknown' in r); assert.equal(r.where, 'leads')
  const rep = summarize([r, activationOf('B', at({ signed_up: 1 }))], 0, 10)
  assert.equal(rep.unknown, 1); assert.equal(rep.dropped_at.read_site, 1); assert.equal(rep.workspaces, 2)
  assert.equal(Object.values(rep.dropped_at).reduce((x, y) => x + y, 0), 1, 'the unknown journey is not counted as a drop-off')
})

test('activationReport: workspaces in the window only, stage counts, drop-offs, first-read reasons, median and p90 time-to-value; bounded and validated', async () => {
  const s = store()
  const day = 86400
  // Five in the window, one before it, one after it.
  for (const [id, t] of [['w1', 10 * day], ['w2', 10 * day + 1], ['w3', 10 * day + 2], ['w4', 10 * day + 3], ['w5', 10 * day + 4], ['old', 1], ['new', 99 * day]] as const) s.ws(id, t)
  await s.read('w1', 10 * day + 10, { path: 'trial', result: 'profile', reason: null })
  await s.read('w2', 10 * day + 10, { path: 'free', result: 'facts', reason: 'not_in_allowlist' })
  await s.read('w3', 10 * day + 10, { path: 'free', result: 'facts', reason: 'not_in_allowlist' })
  await s.read('w4', 10 * day + 10, { path: 'free', result: 'error', reason: 'js_only' })
  for (const [id, mins] of [['w1', 30], ['w2', 90], ['w3', 600]] as const) {
    await record(s.db, { tenantId: id, actorId: id, action: 'settings.changed', resourceType: 'profile' }, 10 * day + 20)
    s.job(`j-${id}`, id, 10 * day + 30); s.lead(`j-${id}`, 10 * day + mins * 60)
  }
  s.ws('x', 10 * day + 5); s.job('j-old', 'old', 2); s.lead('j-old', 3)   // a workspace in the window with nothing, and old rows
  const r = await activationReport(s.db, s.db, { since: 10 * day, until: 11 * day })
  assert.equal(r.workspaces, 6); assert.equal(r.unknown, 0); assert.equal(r.truncated, false)
  assert.deepEqual(r.reached, { signed_up: 6, read_site: 4, saved_offer: 3, started_scan: 3, verified_lead: 3 })
  assert.deepEqual(r.dropped_at, { signed_up: 0, read_site: 2, saved_offer: 1, started_scan: 0, verified_lead: 0 })
  assert.deepEqual(r.first_read, { 'trial/profile/-': 1, 'free/facts/not_in_allowlist': 2, 'free/error/js_only': 1 })
  assert.deepEqual(r.ttv_s, { n: 3, median: 90 * 60 - 1, p90: 600 * 60 - 2 })
  const text = formatActivation(r)
  assert.match(text, /verified_lead\s+reached\s+3/); assert.match(text, /median 1\.5 h, p90 10\.0 h \(n=3\)/); assert.match(text, /free\/facts\/not_in_allowlist: 2/)
  for (const bad of [{ since: Number.NaN, until: 1 }, { since: 5, until: 5 }, { since: 9, until: 3 }, { since: -1, until: 3 }, { since: 1.5, until: 3 }, { since: '1', until: 3 }])
    await assert.rejects(activationReport(s.db, s.db, bad as never), RangeError, JSON.stringify(bad))
  // More workspaces than the report reads: the first REPORT_MAX, and truncated says so.
  const big = store()
  const ins = big.raw.prepare("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'b', 'personal', ?, ?)")
  big.raw.transaction(() => { for (let i = 0; i <= REPORT_MAX; i++) ins.run(`t${i}`, `t${i}`, 100 + i) })()
  const t = await activationReport(big.db, big.db, { since: 0, until: 1_000_000 })
  assert.equal(t.workspaces, REPORT_MAX); assert.equal(t.truncated, true); assert.equal(t.dropped_at.read_site, REPORT_MAX)
})

test('#409 the real routes record every website read (configured trial, missing operator key, exhausted budget, JS-only, fetch failure, a throw) and the journey reads back', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/site-read-route-loader.mjs', '--test', './test/helpers/activation-route-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# fail 0\b/)
  assert.match(r.stdout, /ACTIVATION_ROUTE ok/)
})
