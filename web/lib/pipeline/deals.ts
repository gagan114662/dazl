// Deals (#366, first slice): a qualified conversation becomes a deal with an owner, moves through audited stages and
// closes won or lost. Named "deals" because "opportunity" already means a qualified lead in previews (lib/journey.ts).
//   create   only for a lead of the tenant with a qualified conversation: a reply a person wrote that is interested or
//            not yet sorted (inbound_messages positive / other), or a Cal.com booking matched to it. One open deal per lead.
//   owner    a member of the tenant's workspace (memberships); never someone outside it
//   stages   qualified -> meeting -> proposal -> negotiation -> won | lost. Open stages move freely; won needs an amount
//            and a currency, lost a reason. A closed deal changes only by an explicit reopen (back to qualified).
//   history  every create, move, owner change and reopen is an event (deal_stage_events) with who and when, so a deal's
//            stage at any past time can be rebuilt; nothing is overwritten without a trace
//   writes   carry the version the caller saw; a stale version is refused (two people editing at once never both win)
//   revenue  won amounts are summed per currency, never across currencies (no conversion is assumed)
// Tenant-scoped throughout. On the Db layer (SQLite and Postgres); migrateDeals is the SQLite schema (PG: 0017).
import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from '../db/client.ts'

export const STAGES = ['qualified', 'meeting', 'proposal', 'negotiation', 'won', 'lost'] as const
export type Stage = typeof STAGES[number]
const OPEN = new Set<Stage>(['qualified', 'meeting', 'proposal', 'negotiation'])
export const isStage = (v: unknown): v is Stage => typeof v === 'string' && (STAGES as readonly string[]).includes(v)

export function migrateDeals(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deals (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL,
      lead_id       TEXT NOT NULL,
      owner_id      TEXT NOT NULL,
      stage         TEXT NOT NULL CHECK (stage IN ('qualified', 'meeting', 'proposal', 'negotiation', 'won', 'lost')),
      amount_minor  INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0),
      currency      TEXT CHECK (currency IS NULL OR length(currency) = 3),
      close_date    TEXT,
      close_reason  TEXT CHECK (close_reason IS NULL OR length(close_reason) <= 300),
      version       INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS deals_one_open_per_lead ON deals (tenant_id, lead_id) WHERE stage NOT IN ('won', 'lost');
    CREATE INDEX IF NOT EXISTS deals_tenant ON deals (tenant_id, stage);
    CREATE TABLE IF NOT EXISTS deal_stage_events (
      tenant_id  TEXT NOT NULL,
      deal_id    TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      kind       TEXT NOT NULL CHECK (kind IN ('created', 'moved', 'owner', 'reopened')),
      from_stage TEXT,
      to_stage   TEXT,
      owner_id   TEXT,
      actor      TEXT NOT NULL,
      detail     TEXT,
      at         INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, deal_id, seq)
    );
  `)
}

export class DealError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.code = code }
}
export interface Deal { id: string; tenant_id: string; lead_id: string; owner_id: string; stage: Stage; amount_minor: number | null; currency: string | null; close_date: string | null; close_reason: string | null; version: number; created_at: number; updated_at: number }
const nowS = () => Math.floor(Date.now() / 1000)
const num = (v: unknown) => v === null || v === undefined ? null : Number(v)
const row = (r: Deal): Deal => ({ ...r, amount_minor: num(r.amount_minor), version: Number(r.version), created_at: Number(r.created_at), updated_at: Number(r.updated_at) })

function* event(t: Tx, tenantId: string, dealId: string, e: { kind: string; from?: string | null; to?: string | null; owner?: string | null; actor: string; detail?: unknown; at: number }): TxBody<void> {
  const n = yield* t.get<{ n: number }>('SELECT count(*) AS n FROM deal_stage_events WHERE tenant_id = ? AND deal_id = ?', [tenantId, dealId])
  yield* t.run('INSERT INTO deal_stage_events (tenant_id, deal_id, seq, kind, from_stage, to_stage, owner_id, actor, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, dealId, Number(n?.n ?? 0) + 1, e.kind, e.from ?? null, e.to ?? null, e.owner ?? null, e.actor, e.detail === undefined ? null : JSON.stringify(e.detail), e.at])
}
function* isMember(t: Tx, tenantId: string, memberId: string): TxBody<boolean> {
  return !!(yield* t.get('SELECT 1 AS x FROM memberships WHERE tenant_id = ? AND member_id = ?', [tenantId, memberId]))
}
function* load(t: Tx, tenantId: string, dealId: string): TxBody<Deal> {
  const d = yield* t.get<Deal>('SELECT * FROM deals WHERE tenant_id = ? AND id = ?', [tenantId, dealId])
  if (!d) throw new DealError('not_found')
  return row(d)
}
// A lead of this tenant (through its own scan) with a conversation a person qualified it in.
function* qualified(t: Tx, tenantId: string, leadId: string): TxBody<'ok' | 'not_found' | 'not_qualified'> {
  if (!(yield* t.get('SELECT 1 AS x FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?', [leadId, tenantId]))) return 'not_found'
  const reply = yield* t.get("SELECT 1 AS x FROM inbound_messages WHERE tenant_id = ? AND lead_id = ? AND classification IN ('positive', 'other')", [tenantId, leadId])
  // a booking matched to this lead (when #367's booking states land, a cancelled one should not count here)
  const booked = yield* t.get('SELECT 1 AS x FROM calcom_bookings WHERE tenant_id = ? AND lead_id = ?', [tenantId, leadId])
  return reply || booked ? 'ok' : 'not_qualified'
}

export function createDeal(db: Db, tenantId: string, i: { leadId: string; ownerId: string; actor: string; now?: number }): Promise<Deal> {
  const at = i.now ?? nowS()
  return db.tx(function* (t: Tx): TxBody<Deal> {
    const q = yield* qualified(t, tenantId, i.leadId)
    if (q !== 'ok') throw new DealError(q)
    if (!(yield* isMember(t, tenantId, i.ownerId))) throw new DealError('owner_not_member')
    if (yield* t.get("SELECT 1 AS x FROM deals WHERE tenant_id = ? AND lead_id = ? AND stage NOT IN ('won', 'lost')", [tenantId, i.leadId])) throw new DealError('deal_exists')
    const id = crypto.randomBytes(12).toString('hex')
    yield* t.run("INSERT INTO deals (id, tenant_id, lead_id, owner_id, stage, version, created_at, updated_at) VALUES (?, ?, ?, ?, 'qualified', 1, ?, ?)", [id, tenantId, i.leadId, i.ownerId, at, at])
    yield* event(t, tenantId, id, { kind: 'created', to: 'qualified', owner: i.ownerId, actor: i.actor, at })
    return yield* load(t, tenantId, id)
  })
}

const CURRENCY = /^[A-Z]{3}$/
export function moveDeal(db: Db, tenantId: string, dealId: string, i: { to: Stage; actor: string; version: number; amountMinor?: number | null; currency?: string | null; closeDate?: string | null; reason?: string | null; now?: number }): Promise<Deal> {
  const at = i.now ?? nowS()
  return db.tx(function* (t: Tx): TxBody<Deal> {
    const d = yield* load(t, tenantId, dealId)
    if (d.version !== i.version) throw new DealError('stale')
    if (!OPEN.has(d.stage)) throw new DealError('closed') // reopen first
    if (!isStage(i.to) || i.to === d.stage) throw new DealError('bad_stage')
    const amount = i.amountMinor ?? d.amount_minor, currency = (i.currency ?? d.currency)?.toUpperCase() ?? null
    if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0)) throw new DealError('bad_amount')
    if (currency !== null && !CURRENCY.test(currency)) throw new DealError('bad_currency')
    if (i.to === 'won' && (amount === null || currency === null)) throw new DealError('won_needs_amount')
    const reason = typeof i.reason === 'string' ? i.reason.trim().slice(0, 300) : null
    if (i.to === 'lost' && !reason) throw new DealError('lost_needs_reason')
    const closeDate = i.closeDate ?? (OPEN.has(i.to) ? d.close_date : new Date(at * 1000).toISOString().slice(0, 10))
    if (closeDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(closeDate)) throw new DealError('bad_close_date')
    const r = yield* t.run('UPDATE deals SET stage = ?, amount_minor = ?, currency = ?, close_date = ?, close_reason = ?, version = version + 1, updated_at = ? WHERE tenant_id = ? AND id = ? AND version = ?',
      [i.to, amount, currency, closeDate, OPEN.has(i.to) ? null : reason, at, tenantId, dealId, i.version])
    if (r.changes !== 1) throw new DealError('stale')
    yield* event(t, tenantId, dealId, { kind: 'moved', from: d.stage, to: i.to, actor: i.actor, detail: { amount_minor: amount, currency, close_date: closeDate, reason }, at })
    return yield* load(t, tenantId, dealId)
  })
}

export function assignDeal(db: Db, tenantId: string, dealId: string, i: { ownerId: string; actor: string; version: number; now?: number }): Promise<Deal> {
  const at = i.now ?? nowS()
  return db.tx(function* (t: Tx): TxBody<Deal> {
    const d = yield* load(t, tenantId, dealId)
    if (d.version !== i.version) throw new DealError('stale')
    if (!(yield* isMember(t, tenantId, i.ownerId))) throw new DealError('owner_not_member')
    const r = yield* t.run('UPDATE deals SET owner_id = ?, version = version + 1, updated_at = ? WHERE tenant_id = ? AND id = ? AND version = ?', [i.ownerId, at, tenantId, dealId, i.version])
    if (r.changes !== 1) throw new DealError('stale')
    yield* event(t, tenantId, dealId, { kind: 'owner', from: d.stage, to: d.stage, owner: i.ownerId, actor: i.actor, detail: { from_owner: d.owner_id }, at })
    return yield* load(t, tenantId, dealId)
  })
}

export function reopenDeal(db: Db, tenantId: string, dealId: string, i: { actor: string; version: number; reason: string; now?: number }): Promise<Deal> {
  const at = i.now ?? nowS()
  return db.tx(function* (t: Tx): TxBody<Deal> {
    const d = yield* load(t, tenantId, dealId)
    if (d.version !== i.version) throw new DealError('stale')
    if (OPEN.has(d.stage)) throw new DealError('not_closed')
    const reason = (i.reason ?? '').trim().slice(0, 300)
    if (!reason) throw new DealError('reopen_needs_reason')
    if (yield* t.get("SELECT 1 AS x FROM deals WHERE tenant_id = ? AND lead_id = ? AND stage NOT IN ('won', 'lost') AND id <> ?", [tenantId, d.lead_id, dealId])) throw new DealError('deal_exists')
    const r = yield* t.run("UPDATE deals SET stage = 'qualified', close_reason = NULL, version = version + 1, updated_at = ? WHERE tenant_id = ? AND id = ? AND version = ?", [at, tenantId, dealId, i.version])
    if (r.changes !== 1) throw new DealError('stale')
    yield* event(t, tenantId, dealId, { kind: 'reopened', from: d.stage, to: 'qualified', actor: i.actor, detail: { reason }, at })
    return yield* load(t, tenantId, dealId)
  })
}

export async function listDeals(db: Db, tenantId: string): Promise<(Deal & { company: string | null })[]> {
  const rows = await db.all<Deal & { company: string | null }>(`SELECT d.*, l.company FROM deals d LEFT JOIN leads l ON l.id = d.lead_id
    AND EXISTS (SELECT 1 FROM scan_jobs j WHERE j.id = l.scan_job_id AND j.user_id = d.tenant_id)
    WHERE d.tenant_id = ? ORDER BY d.updated_at DESC, d.id LIMIT 200`, [tenantId])
  return rows.map(r => ({ ...row(r), company: r.company ?? null }))
}

export type DealEvent = { seq: number; kind: string; from_stage: string | null; to_stage: string | null; owner_id: string | null; actor: string; detail: unknown; at: number }
export async function dealHistory(db: Db, tenantId: string, dealId: string): Promise<DealEvent[]> {
  const rows = await db.all<DealEvent & { detail: string | null }>('SELECT seq, kind, from_stage, to_stage, owner_id, actor, detail, at FROM deal_stage_events WHERE tenant_id = ? AND deal_id = ? ORDER BY seq', [tenantId, dealId])
  return rows.map(r => ({ ...r, seq: Number(r.seq), at: Number(r.at), detail: r.detail ? JSON.parse(r.detail) : null }))
}
// The stage a deal was in at a past time, rebuilt from its events alone (null: it did not exist yet).
export async function stageAt(db: Db, tenantId: string, dealId: string, at: number): Promise<Stage | null> {
  let stage: Stage | null = null
  for (const e of await dealHistory(db, tenantId, dealId)) { if (e.at > at) break; if (isStage(e.to_stage)) stage = e.to_stage }
  return stage
}

// Pipeline and revenue for the tenant: open deals by stage, won counted once per deal and summed per currency, lost by
// count. Reconciles to the deals themselves (one row per deal; one open deal per lead).
export async function revenueReport(db: Db, tenantId: string): Promise<{ open: Record<string, number>; won: { currency: string; deals: number; amount_minor: number }[]; lost: number }> {
  const stages = await db.all<{ stage: string; n: number }>('SELECT stage, count(*) AS n FROM deals WHERE tenant_id = ? GROUP BY stage', [tenantId])
  const won = await db.all<{ currency: string; deals: number; amount_minor: number }>("SELECT currency, count(*) AS deals, sum(amount_minor) AS amount_minor FROM deals WHERE tenant_id = ? AND stage = 'won' GROUP BY currency ORDER BY currency", [tenantId])
  const open: Record<string, number> = {}
  for (const s of OPEN) open[s] = 0
  let lost = 0
  for (const r of stages) { if (OPEN.has(r.stage as Stage)) open[r.stage] = Number(r.n); else if (r.stage === 'lost') lost = Number(r.n) }
  return { open, won: won.map(w => ({ currency: w.currency, deals: Number(w.deals), amount_minor: Number(w.amount_minor) })), lost }
}
