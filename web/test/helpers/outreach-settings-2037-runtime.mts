import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { NextRequest } from 'next/server'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { addEnrichment } from '../../lib/connectors/store.ts'
import { historyTotals } from '../../lib/scan/history-jobs.ts'
import { POST as actOnDraft } from '../../app/api/outreach/[id]/route.ts'
import { POST as createDraft } from '../../app/api/outreach/route.ts'
import { GET as readBusiness } from '../../app/api/settings/profile/route.ts'
import { GET as readUsage } from '../../app/api/usage/route.ts'
import { acceptReadConsent } from '../../lib/outreach/replies.ts'
import { replyReadingState } from '../../lib/outreach/replies-view.ts'
import { GET as readReplies } from '../../app/api/outreach/replies/route.ts'
import { GET as readSequences } from '../../app/api/outreach/sequences/route.ts'
import { GET as readSettings, PUT as saveSettings } from '../../app/api/outreach/settings/route.ts'
import { setScanDb, setUser } from './tenant-route-db.ts'

test('Google read scope alone is insufficient, and current consent turns both panels on', async t => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  migrateAllSqlite(db)
  setScanDb(db)
  const tenantId = 'workspace-a'
  setUser({ id: tenantId, business_name: 'Example Office' })
  db.prepare("INSERT INTO gmail_accounts (tenant_id, email, refresh_ct, status, read_granted) VALUES (?, ?, 'fixture', 'active', 1)").run(tenantId, 'owner@example.test')
  acceptReadConsent(db, 'different-workspace')

  const check = async (expected: boolean) => {
    const settings = await readSettings()
    const replies = await readReplies()
    assert.equal(settings.status, 200)
    assert.equal(replies.status, 200)
    const state = await settings.json()
    assert.equal(state.gmail.read_granted, true, 'Google scope still exists')
    assert.equal(replyReadingState(await replies.json()) === 'on', expected)
    assert.equal(state.reply_reading_on ?? state.gmail.read_granted, expected, 'the Gmail panel reports effective reply reading')
  }
  await check(false)
  acceptReadConsent(db, tenantId)
  await check(true)
})


test('saving a sender refreshes the mounted Sequences gate on the same workspace', async t => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  migrateAllSqlite(db)
  setScanDb(db)
  setUser({ id: 'sender-workspace', business_name: 'Example Office' })

  const view = readFileSync(new URL('../../app/app/outreach/sequences-client.tsx', import.meta.url), 'utf8')
  const source = ts.createSourceFile('sequences-client.tsx', view, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let effect: ts.Expression | undefined
  const findEffect = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') effect = node.arguments[0]
    if (!effect) ts.forEachChild(node, findEffect)
  }
  findEffect(source)
  assert.ok(effect)
  const displayed: boolean[] = []
  let pending: Promise<void> | undefined
  const window = new EventTarget()
  const load = () => {
    pending = (async () => {
      const response = await readSequences()
      assert.equal(response.status, 200)
      const data = await response.json() as { gates: { id: string; ok: boolean }[] }
      displayed.push(data.gates.find(gate => gate.id === 'sender_identity')!.ok)
    })()
    return pending
  }
  const cleanup = runInNewContext('(' + effect.getText(source) + ')()', { window, load, setNote: assert.fail })
  if (typeof cleanup === 'function') t.after(cleanup)
  await Promise.resolve()
  await pending
  assert.deepEqual(displayed, [false])

  const saved = await saveSettings(new NextRequest('https://dazl.test/api/outreach/settings', {
    method: 'PUT',
    headers: { host: 'dazl.test', origin: 'https://dazl.test', 'content-type': 'application/json' },
    body: JSON.stringify({ sender_name: 'Alex Sender', postal_address: '12 Main Street, Example City' }),
  }))
  assert.equal(saved.status, 200)
  assert.deepEqual(await saved.json(), { ok: true })
  window.dispatchEvent(new Event('sender-updated'))
  await Promise.resolve()
  await pending
  assert.deepEqual(displayed, [false, true], 'the mounted gate reflects the saved sender')
})

function seedDraftApproval(t: TestContext, name: string, businessName: string) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  migrateAllSqlite(db)
  setScanDb(db)
  const tenant = businessName ? 'saved-business' : 'solo-seller'
  const job = 'a'.repeat(24)
  const lead = 'b'.repeat(24)
  const now = Math.floor(Date.now() / 1000)
  const date = new Date((now - 86_400) * 1000).toISOString().slice(0, 10)
  setUser({ id: tenant, business_name: '' })
  db.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, 'owner@seller.example', ?, ?, 'x', 'y')").run(tenant, name, businessName)
  db.prepare(`INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, seller)
    VALUES (?, ?, 'Workspace', 'services', '-', 'Companies opening another site', 'running', 'We provide commercial fit-outs')`).run(job, tenant)
  db.prepare(`INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt,
      event_date, event_date_proof, date_status, source_kind, score, confidence, fit, intent)
    VALUES (?, ?, 'Lee Rivera', 'Buyer fixture', 'buyer.example', 'Opening another site', 'https://buyer.example/news',
      'Opening another site', ?, 'page_bound', 'unverified', 'discover', 85, 85, 4, 4)`).run(lead, job, date)
  for (const [kind, value] of [['person', 'Lee Rivera, Owner'], ['email', 'lee.rivera@buyer.example']]) {
    addEnrichment(db, tenant, lead, { kind, value, connector: 'discover', label: 'published on a public page',
      confidence: null, source_url: 'https://buyer.example/team', source_date: date, retrieved_at: now })
  }
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  const request = () => new NextRequest('https://dazl.test/api/outreach', {
    method: 'POST', headers: { host: 'dazl.test', origin: 'https://dazl.test', 'content-type': 'application/json' },
    body: JSON.stringify({ lead_id: lead }),
  })
  return { db, tenant, lead, request }
}

test('starting approval uses the Business name already saved for the workspace', async t => {
  const { db, tenant, lead, request } = seedDraftApproval(t, '', 'Saved Business')
  const business = await readBusiness()
  assert.equal(business.status, 200)
  assert.equal((await business.json()).business_name, 'Saved Business')

  db.prepare("UPDATE users SET business_name = '' WHERE id = ?").run(tenant)
  const blank = await createDraft(request())
  assert.equal(blank.status, 422, await blank.clone().text())
  assert.equal((await blank.json()).code, 'seller_context_required')

  db.prepare("UPDATE users SET business_name = 'Saved Business' WHERE id = ?").run(tenant)
  const created = await createDraft(request())
  assert.equal(created.status, 201, await created.clone().text())
  assert.match((db.prepare('SELECT body FROM outreach_messages WHERE lead_id = ?').get(lead) as { body: string }).body, /Saved Business/)
})

test('a solo seller with only a personal name can create and approve a draft', async t => {
  const { db, tenant, request } = seedDraftApproval(t, 'Robin Ellis', '')
  const profile = await (await readBusiness()).json()
  assert.equal(profile.business_name, '')
  assert.equal(profile.website, '')
  assert.equal(db.prepare('SELECT 1 FROM outreach_settings WHERE tenant_id = ?').get(tenant), undefined)

  const draft = await createDraft(request())
  assert.equal(draft.status, 201, await draft.clone().text())
  const { id } = await draft.json()
  // The existing send setup still uses a personal sender name and postal address.
  const settings = await saveSettings(new NextRequest('https://dazl.test/api/outreach/settings', {
    method: 'PUT', headers: { host: 'dazl.test', origin: 'https://dazl.test', 'content-type': 'application/json' },
    body: JSON.stringify({ sender_name: 'Robin Ellis', postal_address: '12 Main Street, Example City' }),
  }))
  assert.equal(settings.status, 200, await settings.clone().text())
  db.prepare("INSERT INTO gmail_accounts (tenant_id, email, refresh_ct, status) VALUES (?, 'owner@seller.example', 'fixture', 'active')").run(tenant)
  const approval = await actOnDraft(new NextRequest(`https://dazl.test/api/outreach/${id}`, {
    method: 'POST', headers: { host: 'dazl.test', origin: 'https://dazl.test', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve' }),
  }), { params: Promise.resolve({ id }) })
  assert.equal(approval.status, 200, await approval.clone().text())
  const saved = db.prepare('SELECT status, body, sent_at FROM outreach_messages WHERE id = ?').get(id) as {
    status: string; body: string; sent_at: number | null
  }
  assert.equal(saved.status, 'approved')
  assert.match(saved.body, /Robin Ellis/)
  assert.equal(saved.sent_at, null)
})

test('Settings reports the same seven finished searches as Home and one used free search', async t => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  const previous = process.env.DAZL_TRIAL_ANTHROPIC_KEY
  process.env.DAZL_TRIAL_ANTHROPIC_KEY = 'operator-key-placeholder'
  t.after(() => {
    if (previous === undefined) delete process.env.DAZL_TRIAL_ANTHROPIC_KEY
    else process.env.DAZL_TRIAL_ANTHROPIC_KEY = previous
  })
  migrateAllSqlite(db)
  setScanDb(db)
  const tenant = 'count-workspace'
  db.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, 'count@example.test', 'Owner', 'Workspace', 'x', 'y')").run(tenant)
  db.prepare("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', 'count-provider-subject', ?)").run(tenant)
  db.prepare("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'Workspace', 'personal', ?, 1)").run(tenant, tenant)
  const job = db.prepare(`INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status)
    VALUES (?, ?, 'Workspace', 'services', '-', 'Real search', ?)`)
  for (let i = 0; i < 7; i++) job.run(`finished-${i}`, tenant, 'done')
  job.run('failed-search', tenant, 'failed')
  job.run('other-tenant', 'other-workspace', 'done')
  db.prepare("INSERT INTO trial_scans (tenant_id, job_id, ip_hash) VALUES (?, 'finished-0', 'h')").run(tenant)
  setUser({ id: tenant, business_name: 'Workspace' })

  const home = await historyTotals(sqliteDb(db), tenant)
  const settings = await readUsage(new NextRequest('https://dazl.test/api/usage'))
  assert.equal(settings.status, 200)
  const usage = await settings.json()
  assert.equal(usage.trial.used, 1)
  assert.equal(home.finished, 7)
  assert.equal(usage.finished_searches, home.finished)
})
