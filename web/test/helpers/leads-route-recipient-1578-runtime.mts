// Review of #1578, route seam: GET /api/leads (real handler, stubbed session, no network) while the recipient check's own read of the
// do-not-contact list fails. The list must not serialize that as "not refused": the lead comes back marked unreadable,
// the card keeps Approve off and says why, and the failure is recorded. While the read works, nothing changes.
// #1238: and the header's counts are made from the SAME verdict each lead is sent with. A lead whose address is refused (the
// do-not-contact list, a free-webmail address) is not counted ready by email, and every listed lead's state is the one the browser
// computes from the row it was sent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { addEnrichment } from '../../lib/connectors/store.ts'
import { leadCardSummary } from '../../lib/scan/lead-card.ts'
import { discoverState } from '../../lib/discover/card.ts'
import { setErrorSinks, type ErrorRecord } from '../../lib/ops/errors.ts'
import { GET as leadsGET } from '../../app/api/leads/route.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch

test('#1578 / #1238 GET /api/leads: a refused address is never counted ready, and an unreadable check is "unreadable" on the lead with Approve off', async () => {
  const real = new Database(':memory:'); migrateAllSqlite(real)
  let unreadable = false
  // The same store, except that the read of the do-not-contact list throws while `unreadable` is on. Every other statement of the
  // request runs as written.
  const db = new Proxy(real, { get(target, prop) {
    if (prop === 'prepare') return (sql: string) => { if (unreadable && sql.includes('SELECT email FROM suppressions WHERE tenant_id = ? AND email IN (')) throw new Error('synthetic unreadable-query control'); return target.prepare(sql) }
    const v = Reflect.get(target, prop) as unknown
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
  } })
  setScanDb(db); setUser({ id: 'T', business_name: 'Fit-out Co' })
  const job = 'a'.repeat(24), own = 'b'.repeat(24), free = 'c'.repeat(24), optout = 'd'.repeat(24)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller) VALUES (?, 'T', 'b', 'i', 'l', 'running', 'Dental clinics opening a new location', 'Clinic fit-out contractor')").run(job)
  const day = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10), now = Math.floor(Date.now() / 1000)
  for (const [id, to] of [[own, 'dana@northwind-dental.example'], [free, 'dana.ruiz+fixture@gmail.com'], [optout, 'dana.ruiz@northwind-dental.example']]) {
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, evidence_excerpt, event_date, date_status, confidence, fit, intent, why, source_kind, company_domain) VALUES (?, ?, 'Dana Ruiz', 'Northwind Dental', 'Opening a second clinic', 'https://news.example/northwind', 85, 'Northwind Dental will open its second clinic', ?, 'verified', 85, 4, 4, 'expanding', 'discover', 'northwind-dental.example')").run(id, job, day)
    addEnrichment(db, 'T', id, { connector: 'discover', kind: 'person', value: 'Dana Ruiz, Practice Owner', label: 'named on a public page', source_url: 'https://northwind-dental.example/team', confidence: null, source_date: day, retrieved_at: now })
    addEnrichment(db, 'T', id, { connector: 'discover', kind: 'email', value: to, label: 'published on a public page', source_url: 'https://northwind-dental.example/contact', confidence: null, source_date: day, retrieved_at: now })
  }
  // the third lead's person asked not to be contacted
  db.prepare("INSERT INTO suppressions (tenant_id, email, reason) VALUES ('T', 'dana.ruiz@northwind-dental.example', 'manual')").run()
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)   // leads are stored while the job runs
  type Row = { id: string; recipient_refused?: string | null; discover_state?: string | null }
  type Counts = { found: number; ready: number; ready_email: number; ready_linkedin: number; no_contact: number }
  const read = async () => {
    const res = await leadsGET(new NextRequest(`http://test/api/leads?job_id=${job}`))
    assert.equal(res.status, 200)
    const body = await res.json() as { leads: Row[]; discover_counts: Counts }
    const rows = body.leads
    assert.equal(rows.length, 3)
    // #1238: each lead's state is the one function's answer for the very row the browser receives, and the header counts those states
    for (const r of rows) assert.equal(r.discover_state, discoverState(r as never), `lead ${r.id}: the state sent is the state of the row sent`)
    assert.equal(body.discover_counts.ready_email, rows.filter(r => r.discover_state === 'ready_email').length, 'the header counts the listed states')
    const of = (id: string) => { const r = rows.find(x => x.id === id); assert.ok(r, `lead ${id} is listed`); return { refused: r.recipient_refused, state: r.discover_state, approve: leadCardSummary(r as never).approve } }
    return { own: of(own), free: of(free), optout: of(optout), counts: body.discover_counts }
  }
  const seen: ErrorRecord[] = []
  const restore = setErrorSinks([r => { seen.push(r) }])
  try {
    // control: the read works. A company address is approvable, a free-webmail one and one on the do-not-contact list are refused,
    // the header counts ONE lead ready by email, and nothing is recorded.
    const ok = await read()
    assert.deepEqual([ok.own.refused, ok.own.approve, ok.own.state], [null, { ok: true }, 'ready_email'])
    assert.deepEqual([ok.free.refused, ok.free.state], ['personal_email', 'no_contact'])
    assert.deepEqual([ok.optout.refused, ok.optout.state, ok.optout.approve], ['suppressed', 'no_contact', { ok: false, reason: 'This address is on your do-not-contact list.' }])
    assert.deepEqual([ok.counts.found, ok.counts.ready, ok.counts.ready_email, ok.counts.ready_linkedin, ok.counts.no_contact], [3, 1, 1, 0, 2])
    assert.equal(seen.length, 0)
    // the read fails: no lead is "not refused", none can be approved, and none is counted ready
    unreadable = true
    const bad = await read()
    assert.deepEqual([bad.own.refused, bad.free.refused, bad.optout.refused], ['unreadable', 'unreadable', 'unreadable'])
    assert.deepEqual(bad.own.approve, { ok: false, reason: 'dazl could not check this address just now, so Approve stays off. Reload the page to try again.' })
    assert.equal(bad.free.approve.ok, false)
    assert.deepEqual([bad.counts.found, bad.counts.ready, bad.counts.ready_email, bad.counts.no_contact], [3, 0, 0, 3])
    assert.ok(seen.length >= 1 && seen.every(r => r.source === 'route' && r.where === 'lib/discover/state-db' && r.tenant === null), `the failure is recorded for the operator: ${JSON.stringify(seen.map(r => [r.source, r.where]))}`)
    // and it clears with the fault: no state was written by the failed read
    unreadable = false
    const again = await read()
    assert.deepEqual([again.own.approve, again.counts.ready_email], [{ ok: true }, 1])
  } finally { restore() }
})
