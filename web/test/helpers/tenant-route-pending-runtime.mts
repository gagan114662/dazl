// Two tenants, the real route handlers for the routes that were 'pending' in test/tenant-isolation-manifest.ts: list
// reads and actions that take an id in the body or query. Tenant B, signed in, reads lists and uses tenant A's ids:
// nothing of A's may come back, and A's rows must stay byte-unchanged (B may write rows of its own, e.g. an audit row
// for its own refused attempt). Positive controls show A sees and acts on its own data. Any outbound fetch fails the
// test: no paid model call, no CRM push, no send.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createJob } from '../../lib/scan/store.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import { saveCrmConfig } from '../../lib/crm/index.ts'
import { saveMemory } from '../../lib/memory.ts'

process.env.DB_PATH ??= path.join(mkdtempSync(path.join(tmpdir(), 'dazl-pending-')), 'app.db')
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')

const crm = await import('../../app/api/crm/route.ts')
const hiringFeed = await import('../../app/api/leads/hiring-feed/route.ts')
const polish = await import('../../app/api/outreach/polish/route.ts')
const reopen = await import('../../app/api/outreach/reopen/route.ts')
const outreach = await import('../../app/api/outreach/route.ts')
const replies = await import('../../app/api/replies/route.ts')
const newsjack = await import('../../app/api/seo/newsjack/route.ts')
const watch = await import('../../app/api/watch/route.ts')

const fetchCalls: string[] = []
globalThis.fetch = (async (u: unknown) => { fetchCalls.push(String(u)); throw new Error('Unexpected network call') }) as typeof fetch
const A = { id: 'A', business_name: 'Acme' }, B = { id: 'B', business_name: 'Beta' }
const hex = () => randomBytes(12).toString('hex')
const req = (url: string, method: string, body?: unknown) => new NextRequest(`http://localhost${url}`, {
  method, headers: { 'content-type': 'application/json', host: 'localhost' }, body: body === undefined ? undefined : JSON.stringify(body) })
const MARK = ['ASECRETCO8w2', 'ASECRETQUERY8w2', 'ASECRETTHREAD8w2', 'ASECRETNEWS8w2', 'ASECRETWATCH8w2', 'ASECRETREOPEN8w2', 'asecret8w2.invalid']

// Tenant A's rows only: anything owned by B (or by nobody) is left out, so B's own audit rows do not count as a change.
function aRows(db: Database.Database): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(t => t.name)
  return JSON.stringify(tables.map(t => {
    const rows = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all() as Record<string, unknown>[]
    return [t, rows.filter(r => r.tenant_id !== 'B' && r.user_id !== 'B')]
  }))
}

function build() {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  setScanDb(db)
  const now = Math.floor(Date.now() / 1000)
  for (const t of ['A', 'B']) {
    saveKey(db, t, 'anthropic', `sk-ant-FIXTURE${t}-AAAAAAAAAAAAAAAAAAAAAA`, Buffer.from(process.env.DAZL_MASTER_KEY!, 'base64'))
    saveCrmConfig(db, t, { provider: 'hubspot', key: `fixture-crm-key-${t}` })
    saveMemory(db, t, { positioning: `${t} sells fixtures` })
  }
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'software', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = hex()
  db.prepare("INSERT INTO leads (id, scan_job_id, company, name, signal, source_url, score, confidence, human_confirmed_at, evidence_excerpt, company_domain, source_kind) VALUES (?, ?, 'ASECRETCO8w2', 'Pat', 'Hiring', 'https://asecret8w2.invalid/jobs', 70, 80, 1, 'ASECRETCO8w2 is hiring', 'asecret8w2.invalid', 'query')").run(lead, job)
  const lead2 = hex() // for A's own draft-create control: has a published contact address
  db.prepare("INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url, score, confidence, human_confirmed_at, evidence_excerpt, company_domain, source_kind) VALUES (?, ?, 'ASECRETCO8w2', 'Sam', 'hello@asecret8w2.invalid', 'Hiring', 'https://asecret8w2.invalid/jobs2', 70, 80, 1, 'ASECRETCO8w2 is hiring', 'asecret8w2.invalid', 'query')").run(lead2, job)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  const draft = hex()
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES (?, 'A', ?, 'pat@asecret8w2.invalid', 'ASECRETCO8w2 subject', 'Fixture body text long enough for the guard, twenty chars plus.', 'draft')").run(draft, lead)
  db.prepare("INSERT INTO hiring_feed_crawl (lead_id, tenant_id, job_id, company_key, status, started_at) VALUES (?, 'A', ?, 'asecret8w2.invalid', 'failed', ?)").run(lead, job, now - 3600)
  db.prepare("INSERT INTO reply_queries (tenant_id, query, position) VALUES ('A', 'ASECRETQUERY8w2', 0)").run()
  const thread = hex()
  db.prepare("INSERT INTO reply_threads (id, tenant_id, platform, url, title, quote, query) VALUES (?, 'A', 'reddit', 'https://reddit.invalid/r/a', 'ASECRETTHREAD8w2', 'q', 'ASECRETQUERY8w2')").run(thread)
  const news = hex()
  db.prepare("INSERT INTO newsjacks (id, tenant_id, url, title, draft) VALUES (?, 'A', 'https://news.invalid/a', 'ASECRETNEWS8w2', 'ASECRETNEWS8w2 draft')").run(news)
  const w = hex()
  db.prepare("INSERT INTO watches (id, user_id, query, icp, next_run_at) VALUES (?, 'A', 'ASECRETWATCH8w2', '{}', ?)").run(w, now + 86400)
  db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent) VALUES ('A', 'tA8', ?, 'pat@asecret8w2.invalid', 'r@x', ?, ?, 2)").run(lead, now - 86400 * 45, now - 86400 * 45)
  db.prepare("INSERT INTO reopen_messages (tenant_id, thread_id, lead_id, to_email, body) VALUES ('A', 'tA8', ?, 'pat@asecret8w2.invalid', 'ASECRETREOPEN8w2 body long enough to pass the check.')").run(lead)
  return { db, job, lead, lead2, draft, thread, news, w }
}

test("tenant B cannot read or change tenant A's rows through the list, body-id and query-id routes; A's own calls work", async () => {
  const f = build()
  const { db } = f
  const before = aRows(db)
  const done: string[] = []
  const failures: string[] = []
  const asB = async (name: string, call: () => Promise<Response | undefined>, ok: (status: number, body: string) => boolean) => {
    setUser(B)
    const res = await call()
    if (!res) { failures.push(`${name}: no response`); return }
    const text = await res.text()
    done.push(name)
    if (!ok(res.status, text)) failures.push(`${name}: B got ${res.status} ${text.slice(0, 160)}`)
    for (const m of MARK) if (text.includes(m)) failures.push(`${name}: response leaks A's ${m}`)
    const after = aRows(db)
    if (after !== before) {
      const a0 = JSON.parse(before) as [string, unknown[]][], a1 = JSON.parse(after) as [string, unknown[]][]
      const t = a1.filter(([n, r]) => JSON.stringify(r) !== JSON.stringify(a0.find(x => x[0] === n)?.[1])).map(([n]) => n)
      failures.push(`${name}: A's data changed in ${t.join(', ')}`)
    }
  }
  const is404 = (s: number) => s === 404
  await asB('GET /api/crm', () => crm.GET(), s => s === 200)
  await asB('POST /api/crm', () => crm.POST(req('/api/crm', 'POST', { action: 'push', lead_id: f.lead })), is404)
  await asB('GET /api/leads/hiring-feed', () => hiringFeed.GET(req(`/api/leads/hiring-feed?job_id=${f.job}`, 'GET')), (s, b) => s === 200 && JSON.parse(b).contacts.length === 0)
  await asB('POST /api/leads/hiring-feed', () => hiringFeed.POST(req('/api/leads/hiring-feed', 'POST', { retry_job_id: f.job })), (s, b) => s === 202 && JSON.parse(b).retrying === 0)
  await asB('POST /api/outreach/polish', () => polish.POST(req('/api/outreach/polish', 'POST', { message_id: f.draft })), (s, b) => s === 200 && JSON.parse(b).rewritten === false)
  await asB('GET /api/outreach/reopen', () => reopen.GET(), s => s === 200)
  await asB('POST /api/outreach', () => outreach.POST(req('/api/outreach', 'POST', { lead_id: f.lead })), is404)
  await asB('GET /api/replies', () => replies.GET(), s => s === 200)
  await asB('POST /api/replies', () => replies.POST(req('/api/replies', 'POST', { action: 'dismiss', id: f.thread })), is404)
  await asB('GET /api/seo/newsjack', () => newsjack.GET(), s => s === 200)
  await asB('POST /api/seo/newsjack', () => newsjack.POST(req('/api/seo/newsjack', 'POST', { action: 'approve', id: f.news })), is404)
  await asB('GET /api/watch', () => watch.GET(), s => s === 200)
  await asB('POST /api/watch', () => watch.POST(req('/api/watch', 'POST', { action: 'pause', id: f.w })), is404)
  assert.deepEqual(failures, [])
  assert.equal(fetchCalls.length, 0, 'B never caused a network call (no model call, no CRM push)')

  // Every 'session-scope' handler (takes no resource id; the tenant comes only from the session), called by B with an
  // empty JSON body: nothing of A's comes back and A's rows stay unchanged. B's own rows may change.
  const { ROUTES } = await import('../tenant-isolation-manifest.ts')
  let swept = 0
  for (const r of ROUTES) {
    if (r.auth !== 'session' || r.crossTenant !== 'session-scope') continue
    const mod = await import(`../../app/api/${r.path}/route.ts`) as Record<string, (q: NextRequest, c: unknown) => Promise<Response | undefined>>
    const body = r.method === 'GET' || r.method === 'DELETE' ? undefined : {}
    await asB(`${r.method} /api/${r.path} (session-scope sweep)`, () => mod[r.method](req(`/api/${r.path}`, r.method, body), { params: Promise.resolve({}) }), () => true)
    swept++
  }
  assert.deepEqual(failures, [])
  assert.equal(fetchCalls.length, 0, `the sweep made network attempts: ${fetchCalls.join(', ')}`)
  console.log('SWEPT', swept)

  // Positive controls: A sees its own data and its actions act.
  setUser(A)
  const text = async (p: Promise<Response | undefined>) => (await (await p)!.text())
  assert.match(await text(crm.GET()), /"configured":true/)
  assert.match(await text(reopen.GET()), /ASECRETREOPEN8w2/)
  assert.match(await text(replies.GET()), /ASECRETQUERY8w2/)
  assert.match(await text(newsjack.GET()), /ASECRETNEWS8w2/)
  assert.match(await text(watch.GET()), /ASECRETWATCH8w2/)
  assert.equal((await watch.POST(req('/api/watch', 'POST', { action: 'pause', id: f.w })))!.status, 200)
  assert.equal((await newsjack.POST(req('/api/seo/newsjack', 'POST', { action: 'approve', id: f.news })))!.status, 200)
  assert.equal((await replies.POST(req('/api/replies', 'POST', { action: 'dismiss', id: f.thread })))!.status, 200)
  const hf = JSON.parse(await text(hiringFeed.GET(req(`/api/leads/hiring-feed?job_id=${f.job}`, 'GET'))))
  assert.equal(hf.contacts.length, 1)

  // Same-action positives for the four handlers whose B call was a refusal or no-op: A's own call gets past the tenant
  // check and acts. Where the action leaves the app, it reaches the external boundary, which the fetch stub refuses,
  // so nothing real is called (no CRM push, no model call) - the attempt itself is the evidence.
  const outbound = () => fetchCalls.splice(0).map(u => new URL(u).hostname)
  outbound()
  const push = (await crm.POST(req('/api/crm', 'POST', { action: 'push', lead_id: f.lead })))!
  assert.equal(push.status, 502) // looked up A's lead, attempted the push, the stub refused it
  assert.deepEqual(outbound(), ['api.hubapi.com'])
  const pol = JSON.parse(await text(polish.POST(req('/api/outreach/polish', 'POST', { message_id: f.draft }))))
  assert.equal(pol.rewritten, false)
  assert.deepEqual(outbound(), ['api.anthropic.com']) // found A's draft and went to A's own provider key
  const retry = JSON.parse(await text(hiringFeed.POST(req('/api/leads/hiring-feed', 'POST', { retry_job_id: f.job }))))
  assert.equal(retry.retrying, 1) // claimed A's failed crawl row
  const drafted = (await outreach.POST(req('/api/outreach', 'POST', { lead_id: f.lead2 })))!
  const dj = await drafted.json() as { id?: string; code?: string }
  assert.equal(drafted.status, 201, JSON.stringify(dj))
  assert.ok(db.prepare("SELECT 1 FROM outreach_messages WHERE id = ? AND tenant_id = 'A'").get(dj.id))
  console.log('COHORT', done.length, JSON.stringify(done))
})
