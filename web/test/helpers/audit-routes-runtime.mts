// The audit trail (#371) through the real route handlers and the real session lookup (audit-session-loader.mjs), one
// SQLite fixture store: each privileged request leaves one attributable event in the workspace it acted in, under the
// account that acted (an admin or operator acting in another owner's workspace is recorded there, under their own id;
// who, what, which resource, the request's correlation id), no secret value or user-typed text reaches the trail, the trail is
// readable by owners and admins only ('GET /api/workspace/audit'), a refused read is itself a denied event, and another
// workspace's owner sees none of it. Every outbound call is answered by a stub here (Stripe test mode, a model-key
// check) or fails the run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { withJar } from './pg-session-headers.ts'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createPasswordUser, createSession, hashToken } from '../../lib/auth-db.ts'
import { setErrorSinks } from '../../lib/ops/errors.ts'
import type { ErrorRecord } from '../../lib/ops/errors.ts'

const fetched: string[] = []
globalThis.fetch = (async (u: unknown) => {
  const url = String(u)
  fetched.push(url)
  if (url.startsWith('https://api.anthropic.com/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'claude-test' }] }), { status: 200 })
  if (url === 'https://api.stripe.com/v1/checkout/sessions') return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), { status: 200 })
  throw new Error(`Unexpected network call ${url}`)
}) as typeof fetch
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic'
process.env.STRIPE_PRICE_PRO = 'price_synthetic'

const raw = new Database(':memory:')
migrateAllSqlite(raw)
setScanDb(raw)
const route = async (p: string) => await import(`../../app/api/${p}/route.ts`)
const [llmKey, enrichment, calcom, crm, gmailDisconnect, sender, exportRoute, quarantine, warm, checkout, monitor, auditRoute, competitors, monitors, replies, sequences, profile, memory] = await Promise.all(
  ['settings/llm-key', 'settings/enrichment', 'settings/calcom', 'crm', 'gmail/disconnect', 'outreach/settings', 'leads/export', 'leads/[lead]/quarantine', 'warm/connections', 'billing/checkout', 'monitors/[id]', 'workspace/audit',
    'settings/competitors', 'monitors', 'outreach/replies', 'outreach/sequences', 'settings/profile', 'settings/memory'].map(route))

// Synthetic markers: none of these may ever appear in the audit table.
const MARK = {
  modelKey: `sk-ant-api03-${'M'.repeat(40)}`, enrichKey: `enrich-${'E'.repeat(30)}`, crmKey: `pat-na1-${'C'.repeat(30)}`,
  address: '1 Marker Street, Secretville', sender: 'Marker Sender Name', reason: 'MARKER typed quarantine reason',
}
const lastId: { v: string } = { v: '' }
const req = (path: string, method: string, body?: unknown) => {
  lastId.v = randomUUID()
  return new NextRequest(`http://localhost${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-request-id': lastId.v },
  })
}
const as = <T,>(token: string, fn: () => Promise<T>) => withJar(new Map([['dazl_session', token]]), fn)
const user = (id: string) => ({ id, email: `${id.toLowerCase()}@example.test`, name: id, business_name: `Biz ${id}`, password_hash: 'h'.repeat(128), salt: 's'.repeat(32) })
type Ev = { action: string; actor_id: string; actor_kind: string; resource_type: string; resource_id: string | null; decision: string; summary: Record<string, unknown>; correlation_id: string | null }
const read = (token: string, q = ''): Promise<Response> => as(token, () => auditRoute.GET(req(`/api/workspace/audit${q}`, 'GET')) as Promise<Response>)

test("privileged requests leave attributable, redacted events; 'GET /api/workspace/audit' is owners' and admins' only, and scoped to the caller's workspace", async () => {
  for (const id of ['A', 'D', 'O', 'V', 'B']) await createPasswordUser(user(id))
  // workspace A: owner A, admin D, operator O, viewer V; workspace B: owner B
  raw.prepare("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES ('A', 'D', 'admin', 1), ('A', 'O', 'operator', 1), ('A', 'V', 'viewer', 1)").run()
  const t: Record<string, string> = {}
  for (const id of ['A', 'D', 'O', 'V', 'B']) t[id] = await createSession(id)
  for (const id of ['D', 'O', 'V']) raw.prepare("UPDATE sessions SET active_tenant_id = 'A' WHERE id = ?").run(hashToken(t[id]))
  const job = 'a'.repeat(24), lead = 'b'.repeat(24), mon = 'c'.repeat(24)
  raw.prepare("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location) VALUES (?, 'A', 'running', 'Acme', 'software', 'Toronto')").run(job)
  raw.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url) VALUES (?, ?, 'Pat', 'Lead Co', 'hiring', 'https://x.example/a')").run(lead, job)
  raw.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  raw.prepare("INSERT INTO monitors (id, user_id, query, interval_hours, next_run_at, created_at) VALUES (?, 'A', 'dentists', 24, 0, 1)").run(mon)

  const corr: Record<string, string> = {}
  const step = async (name: string, token: string, fn: () => Promise<Response>, status = 200) => {
    const r = await as(token, fn)
    assert.equal(r.status, status, `${name}: ${await r.clone().text()}`)
    corr[name] = lastId.v
    return r
  }
  await step('llm key saved', t.A, () => llmKey.PUT(req('/api/settings/llm-key', 'PUT', { vendor: 'anthropic', api_key: MARK.modelKey })))
  await step('llm key removed', t.A, () => llmKey.DELETE(req('/api/settings/llm-key?vendor=anthropic', 'DELETE')))
  await step('enrichment saved', t.D, () => enrichment.POST(req('/api/settings/enrichment', 'POST', { connector: 'enrich:apollo', key: MARK.enrichKey })))
  await step('enrichment removed', t.D, () => enrichment.POST(req('/api/settings/enrichment', 'POST', { connector: 'enrich:apollo', disconnect: true })))
  const rotated = await (await step('calcom rotated', t.A, () => calcom.POST(req('/api/settings/calcom', 'POST', { action: 'rotate' })))).json() as { secret: string }
  await step('crm saved', t.A, () => crm.POST(req('/api/crm', 'POST', { action: 'save', provider: 'hubspot', key: MARK.crmKey })))
  await step('crm removed', t.A, () => crm.POST(req('/api/crm', 'POST', { action: 'disconnect' })))
  await step('gmail removed', t.A, () => gmailDisconnect.POST(req('/api/gmail/disconnect', 'POST')))
  await step('sender saved', t.A, () => sender.PUT(req('/api/outreach/settings', 'PUT', { sender_name: MARK.sender, postal_address: MARK.address, booking_url: '' })))
  await step('leads exported', t.A, () => exportRoute.GET(req(`/api/leads/export?job_id=${job}`, 'GET')))
  await step('lead quarantined', t.O, () => quarantine.POST(req(`/api/leads/${lead}/quarantine`, 'POST', { reason: MARK.reason }), { params: Promise.resolve({ lead }) }))
  await step('lead released', t.O, () => quarantine.DELETE(req(`/api/leads/${lead}/quarantine`, 'DELETE'), { params: Promise.resolve({ lead }) }))
  await step('connections imported', t.A, () => warm.POST(req('/api/warm/connections', 'POST', { csv: 'First Name,Last Name,URL,Connected On\nAda,Lovelace,https://linkedin.com/in/adalovelace,15 Mar 2024\n' })))
  await step('connections deleted', t.A, () => warm.DELETE(req('/api/warm/connections', 'DELETE')))
  await step('checkout started', t.A, () => checkout.POST(req('/api/billing/checkout', 'POST')))
  // a viewer is refused by role (403) and nothing is deleted or recorded
  await step('viewer delete refused', t.V, () => warm.DELETE(req('/api/warm/connections', 'DELETE')), 403)
  await step('monitor deleted', t.A, () => monitor.DELETE(req(`/api/monitors/${mon}`, 'DELETE'), { params: Promise.resolve({ id: mon }) }))
  assert.deepEqual(fetched.map(u => new URL(u).host), ['api.anthropic.com', 'api.stripe.com'], 'only the stubbed model-key check and Stripe test-mode checkout')

  // owners and admins read the trail; operators and viewers are refused, and each refusal is a denied event
  for (const who of ['O', 'V']) {
    const r = await read(t[who])
    assert.equal(r.status, 403, who)
    assert.deepEqual(await r.json(), { error: 'forbidden', needs: 'members' })
  }
  const r = await read(t.D)
  assert.equal(r.status, 200)
  const events = ((await r.json()) as { events: Ev[] }).events.reverse()
  assert.deepEqual(events.map(e => `${e.decision} ${e.actor_id} ${e.action} ${e.resource_type}${e.resource_id ? ` ${e.resource_id}` : ''}`), [
    'allowed A credential.saved llm_key anthropic', 'allowed A credential.removed llm_key anthropic',
    'allowed D credential.saved enrichment enrich:apollo', 'allowed D credential.removed enrichment enrich:apollo',
    'allowed A credential.rotated calcom', 'allowed A credential.saved crm hubspot', 'allowed A credential.removed crm',
    'allowed A credential.removed gmail', 'allowed A settings.changed sender', `allowed A export.leads scan_job ${job}`,
    `allowed O pipeline.quarantined lead ${lead}`, `allowed O pipeline.released lead ${lead}`,
    'allowed A data.deleted warm_connections', 'allowed A billing.checkout_started plan', `allowed A data.deleted monitor ${mon}`,
    'denied O audit.read audit', 'denied V audit.read audit',
  ])
  // each event carries the request's correlation id
  const byAction = (a: string, actor?: string) => events.find(e => e.action === a && (!actor || e.actor_id === actor))!
  assert.equal(events.find(e => e.resource_type === 'enrichment' && e.action === 'credential.saved')!.correlation_id, corr['enrichment saved'])
  assert.equal(byAction('billing.checkout_started').correlation_id, corr['checkout started'])
  assert.deepEqual(byAction('export.leads').summary, { rows: 1, fixtures: false })
  assert.deepEqual(byAction('pipeline.quarantined').summary, { with_reason: true })
  assert.deepEqual(byAction('settings.changed').summary, { booking_link: false })
  assert.deepEqual(byAction('data.deleted').summary, { rows: 1 })
  assert.deepEqual(byAction('audit.read', 'V').summary, { role: 'viewer' })
  assert.ok(events.every(e => e.actor_kind === 'user'))
  // every event is in workspace A, whoever acted
  assert.deepEqual([...new Set((raw.prepare("SELECT tenant_id FROM audit_events WHERE action != 'export.audit'").all() as { tenant_id: string }[]).map(x => x.tenant_id))], ['A'])

  // nothing secret or user-typed in the trail
  const table = JSON.stringify(raw.prepare('SELECT * FROM audit_events').all())
  for (const [k, v] of Object.entries({ ...MARK, calcomSecret: rotated.secret })) assert.ok(!table.includes(v), `${k} is not in the trail`)

  // filters, then the CSV download, which is itself recorded
  assert.deepEqual(((await (await read(t.A, '?action=credential.&actor=A')).json()) as { events: Ev[] }).events.map(e => e.action), ['credential.removed', 'credential.removed', 'credential.saved', 'credential.rotated', 'credential.removed', 'credential.saved'])
  assert.equal((await read(t.A, '?action=DROP%20TABLE')).status, 400)
  const csv = await read(t.A, '?format=csv')
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8')
  const lines = (await csv.text()).trim().split('\n')
  assert.equal(lines[0], 'at,actor_id,actor_kind,action,resource_type,resource_id,decision,summary,correlation_id')
  assert.equal(lines.length, 1 + events.length)
  assert.equal(((await (await read(t.A, '?action=export.audit')).json()) as { events: Ev[] }).events.length, 1)

  // another workspace's owner: none of A's events, whatever the query names
  for (const q of ['', '?tenant=A', '?tenant_id=A', '?actor=A', '?actor=D', '?action=credential.']) {
    const b = await read(t.B, q)
    assert.equal(b.status, 200)
    assert.deepEqual(((await b.json()) as { events: Ev[] }).events, [], `B ${q}`)
  }
  // more administrative actions, by members acting in A
  await step('competitors set', t.D, () => competitors.PUT(req('/api/settings/competitors', 'PUT', { competitors: ['Rival Co'] })))
  const made = await (await step('monitor created', t.O, () => monitors.POST(req('/api/monitors', 'POST', { query: 'dentists in Toronto', interval_hours: 168 })), 201)).json() as { id: string }
  await step('monitor paused', t.O, () => monitor.PATCH(req(`/api/monitors/${made.id}`, 'PATCH', { enabled: false }), { params: Promise.resolve({ id: made.id }) }))
  await step('reply reading revoked', t.A, () => replies.POST(req('/api/outreach/replies', 'POST', { action: 'revoke' })))
  // stopping a sequence that does not exist changes nothing and records nothing
  await step('sequence stop no-op', t.A, () => sequences.POST(req('/api/outreach/sequences', 'POST', { action: 'stop', id: 'zzz' })))
  assert.equal((raw.prepare("SELECT count(*) AS n FROM audit_events WHERE action LIKE 'sequence.%'").get() as { n: number }).n, 0)
  const more = ((await (await read(t.A, '?limit=4')).json()) as { events: Ev[] }).events.reverse()
  assert.deepEqual(more.map(e => `${e.actor_id} ${e.action} ${e.resource_type}${e.resource_id ? ` ${e.resource_id}` : ''}`), [
    'D settings.changed competitors', `O monitor.created monitor ${made.id}`, `O monitor.disabled monitor ${made.id}`, 'A consent.revoked reply_reading',
  ])
  assert.deepEqual(more[0].summary, { count: 1 })
  assert.ok(!JSON.stringify(raw.prepare('SELECT * FROM audit_events').all()).includes('dentists'), "the monitor's query (user text) is not recorded")
  // configuration changes say which parts changed, never their text
  await step('profile saved', t.D, () => profile.POST(req('/api/settings/profile', 'POST', { sells: 'MARKER sells text', business_name: 'MARKER business name' })))
  await step('memory saved', t.D, () => memory.PUT(req('/api/settings/memory', 'PUT', { icp: 'MARKER icp text for memory', positioning: 'MARKER positioning' })))
  const cfg = ((await (await read(t.A, '?action=settings.&limit=2')).json()) as { events: Ev[] }).events.reverse()
  assert.deepEqual(cfg.map(e => [e.actor_id, e.resource_type, e.summary]), [['D', 'profile', { buyer: false, business_name: true }], ['D', 'memory', {}]])
  const trail = JSON.stringify(raw.prepare('SELECT * FROM audit_events').all())
  for (const text of ['MARKER sells', 'MARKER business', 'MARKER icp', 'MARKER positioning', 'Rival Co']) assert.ok(!trail.includes(text), `${text} is not in the trail`)

  // a CRM push whose result cannot be recorded (the claim write fails) is still in the trail, as unknown
  await step('crm saved again', t.A, () => crm.POST(req('/api/crm', 'POST', { action: 'save', provider: 'hubspot', key: MARK.crmKey })))
  raw.exec("CREATE TRIGGER dazl_test_refuse_claim BEFORE UPDATE ON crm_push_claims BEGIN SELECT RAISE(ABORT, 'refused'); END")
  const restoreSinks = setErrorSinks([])
  try {
    const pushed = await step('crm push unrecorded', t.O, () => crm.POST(req('/api/crm', 'POST', { action: 'push', lead_id: lead })), 502)
    assert.equal(((await pushed.json()) as { outcome: string }).outcome, 'unknown')
  } finally { raw.exec('DROP TRIGGER dazl_test_refuse_claim'); restoreSinks() }
  const unrecorded = ((await (await read(t.A, '?action=crm.pushed&limit=1')).json()) as { events: Ev[] }).events[0]
  assert.deepEqual([unrecorded.actor_id, unrecorded.resource_id, unrecorded.summary], ['O', lead, { provider: 'hubspot', outcome: 'unknown', result_recorded: false }])

  // pages: ?cursor= continues exactly after the previous page; a malformed cursor is refused
  const p1 = (await (await read(t.A, '?limit=2')).json()) as { events: Ev[]; next: string }
  const p2 = (await (await read(t.A, `?limit=2&cursor=${p1.next}`)).json()) as { events: Ev[]; next: string }
  const top4 = ((await (await read(t.A, '?limit=4')).json()) as { events: (Ev & { id: string })[] }).events
  assert.deepEqual([...p1.events, ...p2.events].map(e => (e as Ev & { id: string }).id), top4.map(e => e.id))
  assert.equal((await read(t.A, '?cursor=nope')).status, 400)

  // the CSV keeps a cell a spreadsheet would run as a formula as text, and quotes what needs quoting
  raw.prepare("INSERT INTO audit_events (id, tenant_id, actor_id, actor_kind, action, resource_type, resource_id, decision, summary, at, seq) VALUES (?, 'A', 'A', 'user', 'x.formula', 't', ?, 'allowed', '{}', ?, 999999)")
    .run('f'.repeat(24), '=HYPERLINK("http://x.example")', Math.floor(Date.now() / 1000) + 5)
  const csvAll = await (await read(t.A, '?format=csv&action=x.')).text()
  assert.ok(csvAll.includes(`,"'=HYPERLINK(""http://x.example"")",`), csvAll)

  // the CSV is the whole trail, not one page: 1001 more events all come out, and nothing says truncated
  const ins = raw.prepare("INSERT INTO audit_events (id, tenant_id, actor_id, actor_kind, action, resource_type, decision, summary, at, seq) VALUES (?, 'A', 'A', 'user', 'bulk.row', 't', 'allowed', '{}', ?, ?)")
  raw.transaction(() => { for (let i = 0; i < 1001; i++) ins.run(randomBytes(12).toString('hex'), 1000 + i, 1) })()
  const bulk = await read(t.A, '?format=csv&action=bulk.')
  assert.equal((await bulk.text()).trim().split('\n').length, 1 + 1001)
  assert.equal(bulk.headers.get('x-audit-truncated'), null)

  // a failed audit write is reported and never undoes or fails the change it describes
  const caught: ErrorRecord[] = []
  const restore = setErrorSinks([r => { caught.push(r) }])
  raw.exec("CREATE TRIGGER dazl_test_refuse_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'refused'); END")
  try {
    await step('competitors set, audit refused', t.A, () => competitors.PUT(req('/api/settings/competitors', 'PUT', { competitors: ['Other Rival'] })))
  } finally { raw.exec('DROP TRIGGER dazl_test_refuse_audit'); restore() }
  assert.deepEqual(((await ((await as(t.A, () => competitors.GET())) as Response).json()) as { competitors: string[] }).competitors, ['Other Rival'])
  assert.deepEqual(caught.map(r => r.where), ['audit:settings.changed'])
  console.log('AUDIT ROUTES ok')
})
