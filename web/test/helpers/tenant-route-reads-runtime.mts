import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateScan, createJob } from '../../lib/scan/store.ts'
import { migrateOutreach } from '../../lib/outreach/store.ts'
import { migrateReopen, createReopenDraft } from '../../lib/outreach/reopen.ts'
import { migrateReplies } from '../../lib/outreach/replies.ts'
import { migrateMonitors, createMonitor } from '../../lib/monitors.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import { saveMemory } from '../../lib/memory.ts'
import { migrateSourceReview } from '../../lib/scan/source-review.ts'
import { migrateSequences } from '../../lib/outreach/sequences.ts'
import { migrateWatch } from '../../lib/watch.ts'
import { migrateKeys } from '../../lib/llm/key-store.ts'
import { migrateAdvanced } from '../../lib/advanced/index.ts'
import { migrateConnectors } from '../../lib/connectors/store.ts'
import { migratePlans } from '../../lib/plans.ts'
import { migrateBilling } from '../../lib/billing/stripe.ts'
import { migrateAutopilot } from '../../lib/outreach/autopilot.ts'
import { migrateLedger } from '../../lib/outreach/ledger.ts'
import { migrateCsv } from '../../lib/scan/csv-import.ts'
import { migrateCommenterImport } from '../../lib/scan/commenter-import.ts'
import { migrateMemory } from '../../lib/memory.ts'
import { migrateThreadReplies } from '../../lib/replies/threads.ts'
import { migrateTrial } from '../../lib/scan/trial.ts'
import { migrateCompetitors } from '../../lib/signals/competitor-reddit.ts'
import { migrateEvents } from '../../lib/events/store.ts'
import { migrateSeo } from '../../lib/seo/audit.ts'
import { migrateWarm } from '../../lib/warm/connections.ts'
import { GET as leadsGET } from '../../app/api/leads/route.ts'
import { GET as exportGET } from '../../app/api/leads/export/route.ts'
import { GET as jobsGET } from '../../app/api/scan/jobs/route.ts'
import { GET as latestGET } from '../../app/api/scan/latest/route.ts'
import { GET as statusGET } from '../../app/api/scan/status/route.ts'
import { GET as outreachGET } from '../../app/api/outreach/route.ts'
import { GET as inboxGET } from '../../app/api/outreach/inbox/route.ts'
import { GET as followupsGET } from '../../app/api/outreach/followups/route.ts'
import { GET as keyGET } from '../../app/api/settings/llm-key/route.ts'
import { GET as memoryGET } from '../../app/api/settings/memory/route.ts'
import { GET as monitorsGET } from '../../app/api/monitors/route.ts'
import { GET as conversionGET } from '../../app/api/outreach/conversion/route.ts'
import { GET as campaignGET } from '../../app/api/campaigns/[id]/route.ts'

// Local synthetic fixture: two tenants with unique per-tenant markers, the real GET handlers, session switched per call.
// Keys are fixture literals only; no vault, no network (fetch throws).
const fetchCalls: string[] = []
globalThis.fetch = (async (u: unknown) => { fetchCalls.push(String(u)); throw new Error('Unexpected network call') }) as typeof fetch
const A = { id: 'A', business_name: 'Acme' }, B = { id: 'B', business_name: 'Beta' }
const get = (path: string) => new NextRequest(`http://localhost${path}`, { method: 'GET' })
const hex = () => randomBytes(12).toString('hex')
const MA = { sig: 'AMARKERSIGNAL9f3k', co: 'AMARKERCOMPANY9f3k', email: 'amarker9f3k@a.invalid', subj: 'AMARKERSUBJECT9f3k', mon: 'AMARKERQUERY9f3k', mem: 'AMARKERPOSITIONING9f3k', biz: 'AMARKERBIZ9f3k', q: 'AMARKERJOBQUERY9f3k', key: 'sk-ant-FIXTUREAKEY-AAAAAAAAAAAAAAAAAAAAQ9ZK', thread: 'AMARKERTHREAD9f3k' }
const MB = { sig: 'BMARKERSIGNAL7h2m', thread: 'BMARKERTHREAD7h2m', co: 'BMARKERCOMPANY7h2m', biz: 'BMARKERBIZ7h2m', q: 'BMARKERJOBQUERY7h2m', mon: 'BMARKERQUERY7h2m', mem: 'BMARKERPOSITIONING7h2m', subj: 'BMARKERSUBJECT7h2m', key: 'sk-ant-FIXTUREBKEY-BBBBBBBBBBBBBBBBBBBBW4XJ' }
const AMARKS = [MA.sig, MA.co, MA.email, MA.subj, MA.mon, MA.mem, MA.biz, MA.q, MA.thread, 'Q9ZK', 'FIXTUREAKEY']
const BMARKS = [MB.sig, MB.thread, MB.co, MB.biz, MB.q, MB.mon, MB.mem, MB.subj, 'W4XJ']

async function build() {
  const db = new Database(':memory:')
  for (const m of [migrateScan, migrateSourceReview, migrateWatch, migrateKeys, migratePlans, migrateConnectors, migrateAdvanced, migrateBilling, migrateOutreach, migrateAutopilot, migrateLedger, migrateReplies, migrateThreadReplies, migrateSequences, migrateTrial, migrateCompetitors, migrateEvents, migrateWarm, migrateSeo, migrateMonitors, migrateCsv, migrateCommenterImport, migrateMemory, migrateReopen]) m(db)
  setScanDb(db)
  const master = randomBytes(32)
  const now = Math.floor(Date.now() / 1000)
  const seed = (t: string, m: typeof MA | typeof MB, email: string, thread: string | null) => {
    const job = createJob(db, t, { business_name: m.biz, industry: 'test', location: 'test' })
    db.prepare("UPDATE scan_jobs SET status='running', query=? WHERE id=?").run(m.q, job)
    const lead = hex()
    db.prepare("INSERT INTO leads(id,scan_job_id,company,name,contact,signal,source_url,evidence_excerpt,confidence,human_confirmed_at,score) VALUES(?,?,?,'Pat',?,'Hiring','https://x.invalid/jobs',?,80,1,70)").run(lead, job, m.co, email, `${m.co} is hiring`)
    db.prepare("INSERT INTO outreach_messages(id,tenant_id,lead_id,to_email,subject,body,status) VALUES(?,?,?,?,?,?,'draft')").run(hex(), t, lead, email, m.subj, 'Fixture body text long enough for the guard, twenty chars plus.')
    createMonitor(db, t, { query: m.mon })
    saveMemory(db, t, { positioning: m.mem })
    saveKey(db, t, 'anthropic', m.key, master)
    if (thread) db.prepare("INSERT INTO followup_threads(tenant_id,thread_id,lead_id,to_email,root_message_id,last_activity_at,last_lead_reply_at,followups_sent) VALUES(?,?,?,?,'r@x',?,?,0)").run(t, thread, lead, email, now, now)
    if (thread) db.prepare("INSERT INTO inbound_messages(gmail_id,tenant_id,thread_id,lead_id,from_email,excerpt,classification,received_at) VALUES (?,?,?,?,?,?,'positive',?)").run(hex(), t, thread, lead, email, `${thread} excerpt`, now)
    db.prepare("UPDATE outreach_messages SET status='sent', sent_at=? WHERE tenant_id=? AND lead_id=?").run(now, t, lead)
    db.prepare("INSERT INTO outreach_signal_context(message_id,tenant_id,lead_id,scan_job_id,signal_kind,source_kind,captured_at) SELECT id,tenant_id,lead_id,?,?,'query',? FROM outreach_messages WHERE tenant_id=? AND lead_id=?").run(job, m.sig, now, t, lead)
    if (thread) db.prepare("INSERT INTO followup_messages(tenant_id,thread_id,step,status,created_at) VALUES(?,?,0,'sent',?)").run(t, thread, now)
    return { job, lead }
  }
  const a = seed('A', MA, MA.email, MA.thread)
  const b = seed('B', MB, 'bmarker7h2m@b.invalid', MB.thread)
  return { db, a, b }
}

test('all 12 read routes: A and B each get their own content, never the other tenant\'s; A ids look nonexistent to B; GETs do not mutate; unauth is 401 for every route', async () => {
  const { db, a, b } = await build()
  // rate_limits and app_leases are global platform tables (no tenant data); rateLimit() writes there through getDb().
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('rate_limits', 'app_leases') ORDER BY name").all() as { name: string }[]).map(r => r.name)
  const snap = () => JSON.stringify(tables.map(t => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]))
  const before = snap()
  const text = async (r: Response) => r.text()
  // [name, call for a tenant, markers that tenant's own response must contain, id-lookup route?]
  type R = { name: string; call: (t: 'A' | 'B') => Promise<Response>; own: { A: string[]; B: string[] }; id?: (hexId: string) => Promise<Response> }
  const j = (t: 'A' | 'B') => (t === 'A' ? a : b).job
  const routes: R[] = [
    { name: 'GET /api/leads', call: t => leadsGET(get(`/api/leads?job_id=${j(t)}`)), own: { A: [MA.co], B: [MB.co] }, id: h => leadsGET(get(`/api/leads?job_id=${h}`)) },
    { name: 'GET /api/leads/export', call: t => exportGET(get(`/api/leads/export?job_id=${j(t)}`)), own: { A: [MA.co, MA.email], B: [MB.co] } },
    { name: 'GET /api/scan/jobs', call: () => jobsGET(), own: { A: [MA.biz], B: [MB.biz] } },
    { name: 'GET /api/scan/latest', call: () => latestGET(), own: { A: [MA.q], B: [MB.q] } },
    { name: 'GET /api/scan/status', call: t => statusGET(get(`/api/scan/status?job_id=${j(t)}&passive=1`)), own: { A: [a.job], B: [b.job] }, id: h => statusGET(get(`/api/scan/status?job_id=${h}&passive=1`)) },
    // The one-campaign page: owner-scoped, read-only (covered by the byte-unchanged snapshot below).
    { name: 'GET /api/campaigns/[id]', call: t => campaignGET(get(`/api/campaigns/${j(t)}`), { params: Promise.resolve({ id: j(t) }) }), own: { A: [MA.q, MA.co, MA.subj], B: [MB.q, MB.co, MB.subj] }, id: h => campaignGET(get(`/api/campaigns/${h}`), { params: Promise.resolve({ id: h }) }) },
    { name: 'GET /api/outreach', call: () => outreachGET(), own: { A: [MA.subj], B: [MB.subj] } },
    { name: 'GET /api/outreach/inbox thread', call: t => inboxGET(get(`/api/outreach/inbox?thread_id=${t === 'A' ? MA.thread : MB.thread}`)), own: { A: [MA.thread], B: [MB.thread] } },
    { name: 'GET /api/outreach/followups', call: () => followupsGET(), own: { A: [MA.co, MA.thread], B: [MB.co, MB.thread] } },
    { name: 'GET /api/settings/llm-key', call: () => keyGET(), own: { A: ['Q9ZK'], B: ['W4XJ'] } },
    { name: 'GET /api/settings/memory', call: () => memoryGET(), own: { A: [MA.mem], B: [MB.mem] } },
    { name: 'GET /api/outreach/conversion', call: () => conversionGET(), own: { A: [MA.sig], B: [MB.sig] } },
    { name: 'GET /api/monitors', call: () => monitorsGET(), own: { A: [MA.mon], B: [MB.mon] } },
  ]
  const U = { A, B }
  const cohort: string[] = []
  for (const r of routes) {
    cohort.push(r.name)
    for (const t of ['A', 'B'] as const) {
      const o = t === 'A' ? 'B' : 'A'
      setUser(U[t]); const res = await r.call(t); const tx = await text(res)
      assert.equal(res.status, 200, `${r.name}: ${t} own read status`)
      for (const m of r.own[t]) assert.ok(tx.includes(m), `${r.name}: ${t} sees its own marker ${m}`)
      for (const m of (o === 'A' ? AMARKS : BMARKS)) assert.ok(!tx.includes(m), `${r.name}: ${t} body leaks ${o} marker ${m.startsWith(o + 'MARKER') ? m : 'key material'}`)
      assert.ok(!tx.includes(o === 'A' ? MA.key : MB.key), `${r.name}: no ${o} key in ${t} body`)
    }
    // Cross-tenant: B asking for A's object (same call shape as A's own).
    setUser(B)
    const cross = await r.call('A'); const ct = await text(cross)
    if (r.id) {
      assert.equal(cross.status, 404, `${r.name}: B with A's id`)
      const nx = r.id(hex()); const nr = await nx
      assert.equal(nr.status, 404); assert.equal(ct, await text(nr), `${r.name}: A's id answers exactly like a nonexistent id`)
    } else if (r.name === 'GET /api/outreach/inbox thread') {
      const unk = await text(await inboxGET(get(`/api/outreach/inbox?thread_id=${hex()}`)))
      assert.equal(ct, unk, `${r.name}: A's thread answers like an unknown thread`)
    }
    if (r.name === 'GET /api/leads/export') assert.ok(!ct.includes(MA.co), `${r.name}: B with A's job exports no A row`)
    for (const m of AMARKS) assert.ok(!ct.includes(m), `${r.name}: cross call leaks A marker ${m}`)
  }
  assert.equal(snap(), before, 'GET cohort left every table byte-unchanged')
  // Unauthenticated: every route, enumerated.
  setUser(null)
  for (const r of routes) assert.equal((await r.call('A')).status, 401, `${r.name}: unauthenticated`)
  assert.equal(fetchCalls.length, 0)
  console.log('READ COHORT', cohort.length)
})
