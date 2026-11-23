// Review of #1578, route seam: GET /api/leads (real handler, stubbed session, no network) while the recipient check's own read of a
// discovery lead's published address fails. The list must not serialize that as "not refused": the lead comes back marked unreadable,
// the card keeps Approve off and says why, and the failure is recorded. While the read works, nothing changes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { addEnrichment } from '../../lib/connectors/store.ts'
import { leadCardSummary } from '../../lib/scan/lead-card.ts'
import { setErrorSinks, type ErrorRecord } from '../../lib/ops/errors.ts'
import { GET as leadsGET } from '../../app/api/leads/route.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch

test('#1578 GET /api/leads: an unreadable recipient check is "unreadable" on the lead and Approve is off, never "not refused"', async () => {
  const real = new Database(':memory:'); migrateAllSqlite(real)
  let unreadable = false
  // The same store, except that the recipient check's read of the published address throws while `unreadable` is on. Every other
  // statement of the request runs as written.
  const db = new Proxy(real, { get(target, prop) {
    if (prop === 'prepare') return (sql: string) => { if (unreadable && sql.includes("connector = 'discover' AND kind IN ('person', 'email', 'linkedin')")) throw new Error('synthetic unreadable-query control'); return target.prepare(sql) }
    const v = Reflect.get(target, prop) as unknown
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
  } })
  setScanDb(db); setUser({ id: 'T', business_name: 'Fit-out Co' })
  const job = 'a'.repeat(24), own = 'b'.repeat(24), free = 'c'.repeat(24)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller) VALUES (?, 'T', 'b', 'i', 'l', 'running', 'Dental clinics opening a new location', 'Clinic fit-out contractor')").run(job)
  const day = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10), now = Math.floor(Date.now() / 1000)
  for (const [id, to] of [[own, 'dana@northwind-dental.example'], [free, 'dana.ruiz+fixture@gmail.com']]) {
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, evidence_excerpt, event_date, date_status, confidence, fit, intent, why, source_kind, company_domain) VALUES (?, ?, 'Dana Ruiz', 'Northwind Dental', 'Opening a second clinic', 'https://news.example/northwind', 85, 'Northwind Dental will open its second clinic', ?, 'verified', 85, 4, 4, 'expanding', 'discover', 'northwind-dental.example')").run(id, job, day)
    addEnrichment(db, 'T', id, { connector: 'discover', kind: 'person', value: 'Dana Ruiz, Practice Owner', label: 'named on a public page', source_url: 'https://northwind-dental.example/team', confidence: null, source_date: day, retrieved_at: now })
    addEnrichment(db, 'T', id, { connector: 'discover', kind: 'email', value: to, label: 'published on a public page', source_url: 'https://northwind-dental.example/contact', confidence: null, source_date: day, retrieved_at: now })
  }
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)   // leads are stored while the job runs
  type Row = { id: string; recipient_refused?: string | null }
  const read = async () => {
    const res = await leadsGET(new NextRequest(`http://test/api/leads?job_id=${job}`))
    assert.equal(res.status, 200)
    const rows = (await res.json() as { leads: Row[] }).leads
    const of = (id: string) => { const r = rows.find(x => x.id === id); assert.ok(r, `lead ${id} is listed`); return { refused: r.recipient_refused, approve: leadCardSummary(r as never).approve } }
    return { own: of(own), free: of(free) }
  }
  const seen: ErrorRecord[] = []
  const restore = setErrorSinks([r => { seen.push(r) }])
  try {
    // control: the read works. A company address is approvable, a free-webmail one is refused as before, nothing is recorded.
    const ok = await read()
    assert.deepEqual([ok.own.refused, ok.own.approve], [null, { ok: true }])
    assert.equal(ok.free.refused, 'personal_email')
    assert.equal(seen.length, 0)
    // the read fails: neither lead is "not refused", and neither can be approved
    unreadable = true
    const bad = await read()
    assert.deepEqual([bad.own.refused, bad.free.refused], ['unreadable', 'unreadable'])
    assert.deepEqual(bad.own.approve, { ok: false, reason: 'dazl could not check this address just now, so Approve stays off. Reload the page to try again.' })
    assert.equal(bad.free.approve.ok, false)
    assert.ok(seen.length >= 2 && seen.every(r => r.source === 'route' && r.where === '/api/leads' && r.tenant === null), `the failure is recorded for the operator: ${JSON.stringify(seen.map(r => [r.source, r.where]))}`)
    // and it clears with the fault: no state was written by the failed read
    unreadable = false
    assert.deepEqual((await read()).own.approve, { ok: true })
  } finally { restore() }
})
