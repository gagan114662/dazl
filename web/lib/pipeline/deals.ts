// Revenue pipeline (#366): a qualified conversation becomes ONE canonical deal, routed to a workspace member by the
// tenant's ordered rules, moved through audited stages and closed won or lost with a reason. On the Db layer (both
// engines); tables in ./tables.ts.
//
// Definitions (also returned by pipelineReport, so the numbers carry their assumptions):
//   qualified conversation - a reply thread with a reply the rules classified 'positive', tied to one of this
//     workspace's own leads, not a test fixture, with no later opt-out or "no" in the thread, the thread not settled
//     (opt-out, no, bounce, suppression) and the sender not suppressed. Rule-classified, not human-confirmed.
//   canonical deal - one per (workspace, thread): UNIQUE in the schema, so a replayed or concurrent route never makes
//     a second one, and every report counts deals, never messages or replies.
//   attribution - a deal is attributed only to the conversation it was routed from (its thread, lead and play). No
//     multi-touch credit and no causal claim.
//   amounts - integer minor units in the deal's own ISO currency. Never summed across currencies (no FX conversion).
//   history - every change appends a full snapshot to deal_stage_events (UPDATE refused by a trigger), so the state of
//     any deal at any past time is its latest event at or before that time, and the report can be rebuilt as of any
//     moment and checked against the deals table.
//
// Routing runs only for a workspace with at least one active rule: adding the first rule (an admin, 'configure') is
// what turns the pipeline on. A rule's owner must still be a member who may operate (operator, admin, owner) when a
// deal is routed; otherwise that rule is skipped. No matching rule leaves the deal unassigned, visible in the list.
// Nothing here sends mail, calls a provider or writes outside these tables and the audit trail.
import { randomBytes } from 'node:crypto'
import type { Db, Tx, TxBody } from '../db/client.ts'
import { recordTx } from '../audit.ts'

export const OPEN_STAGES = ['new', 'qualified', 'meeting', 'proposal', 'negotiation'] as const
export const STAGES = [...OPEN_STAGES, 'won', 'lost'] as const
export type Stage = typeof STAGES[number]
export const WON_REASONS = ['fit', 'price', 'timing', 'relationship', 'other'] as const
export const LOST_REASONS = ['price', 'competitor', 'no_budget', 'no_decision', 'timing', 'fit', 'unresponsive', 'other'] as const
export const MATCH_KINDS = ['any', 'play', 'domain'] as const
export type MatchKind = typeof MATCH_KINDS[number]
export const MAX_ACTIVE_RULES = 50
export const ROUTER_ACTOR = 'pipeline-router'
const MAX_AMOUNT = 1e13

export const isStage = (v: unknown): v is Stage => typeof v === 'string' && (STAGES as readonly string[]).includes(v)
export const isOpen = (s: Stage) => (OPEN_STAGES as readonly string[]).includes(s)
const nowS = () => Math.floor(Date.now() / 1000)
const newId = () => randomBytes(12).toString('hex')
type Fence = (t: Tx) => TxBody<void>

export interface Deal {
  id: string; thread_id: string; lead_id: string; title: string; owner_id: string | null; stage: Stage
  amount_minor: number | null; currency: string | null; close_date: string | null; close_reason: string | null; close_note: string | null
  rule_id: string | null; route_reason: string; sla_due_at: number | null; created_at: number; updated_at: number; closed_at: number | null; version: number
}
export interface DealEvent { seq: number; kind: string; from_stage: string | null; stage: Stage; owner_id: string | null; amount_minor: number | null; currency: string | null; close_reason: string | null; actor_id: string; at: number }
export interface Rule { id: string; position: number; match_kind: MatchKind; match_value: string; owner_id: string; sla_hours: number | null; active: number; created_by: string; created_at: number }

const DEAL_COLS = 'id, thread_id, lead_id, title, owner_id, stage, amount_minor, currency, close_date, close_reason, close_note, rule_id, route_reason, sla_due_at, created_at, updated_at, closed_at, version'
const num = (v: unknown): number | null => v === null || v === undefined ? null : Number(v)
const str = (v: unknown): string | null => v === null || v === undefined ? null : String(v)
function dealRow(r: Record<string, unknown>): Deal {
  return { id: String(r.id), thread_id: String(r.thread_id), lead_id: String(r.lead_id), title: String(r.title), owner_id: str(r.owner_id), stage: r.stage as Stage,
    amount_minor: num(r.amount_minor), currency: str(r.currency), close_date: str(r.close_date), close_reason: str(r.close_reason), close_note: str(r.close_note),
    rule_id: str(r.rule_id), route_reason: String(r.route_reason), sla_due_at: num(r.sla_due_at), created_at: Number(r.created_at), updated_at: Number(r.updated_at),
    closed_at: num(r.closed_at), version: Number(r.version) }
}
const eventRow = (r: Record<string, unknown>): DealEvent => ({ seq: Number(r.seq), kind: String(r.kind), from_stage: str(r.from_stage), stage: r.stage as Stage, owner_id: str(r.owner_id),
  amount_minor: num(r.amount_minor), currency: str(r.currency), close_reason: str(r.close_reason), actor_id: String(r.actor_id), at: Number(r.at) })

function* appendEvent(t: Tx, tenantId: string, d: Deal, kind: string, fromStage: string | null, actorId: string, at: number): TxBody<void> {
  yield* t.run(`INSERT INTO deal_stage_events (id, tenant_id, deal_id, seq, kind, from_stage, stage, owner_id, amount_minor, currency, close_reason, actor_id, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [newId(), tenantId, d.id, d.version, kind, fromStage, d.stage, d.owner_id, d.amount_minor, d.currency, d.close_reason, actorId.slice(0, 80), at])
}

// Members of THIS workspace who may own a deal. Read inside the caller's transaction.
function* dealOwners(t: Tx, tenantId: string): TxBody<Set<string>> {
  const rows = yield* t.all<{ member_id: string }>("SELECT member_id FROM memberships WHERE tenant_id = ? AND role IN ('owner', 'admin', 'operator')", [tenantId])
  return new Set(rows.map(r => r.member_id))
}

const domainOf = (email: string) => email.trim().toLowerCase().split('@')[1] ?? ''
export function ruleMatches(r: Pick<Rule, 'match_kind' | 'match_value'>, c: { job_id: string; from_email: string }): boolean {
  if (r.match_kind === 'any') return true
  if (r.match_kind === 'play') return r.match_value === c.job_id
  const d = domainOf(c.from_email), v = r.match_value.toLowerCase()
  return d !== '' && (d === v || d.endsWith(`.${v}`))
}

// The owner for one conversation: the first active rule (by position) that matches and whose owner may still own deals.
export function pickOwner(rules: Rule[], owners: Set<string>, c: { job_id: string; from_email: string }): { rule: Rule | null; reason: string } {
  let skipped = false
  for (const r of rules) {
    if (!ruleMatches(r, c)) continue
    if (owners.has(r.owner_id)) return { rule: r, reason: 'rule' }
    skipped = true
  }
  return { rule: null, reason: skipped ? 'owner_not_member' : 'no_matching_rule' }
}

const ACTIVE_RULES = 'SELECT id, position, match_kind, match_value, owner_id, sla_hours, active, created_by, created_at FROM deal_routing_rules WHERE tenant_id = ? AND active = 1 ORDER BY position, created_at, id'

const CANDIDATES = `SELECT m.thread_id AS thread_id, m.lead_id AS lead_id, m.from_email AS from_email, m.received_at AS received_at, m.gmail_id AS gmail_id,
       l.company AS company, l.name AS name, j.id AS job_id
  FROM inbound_messages m
  JOIN leads l ON l.id = m.lead_id
  JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = m.tenant_id
 WHERE m.tenant_id = ? AND m.classification = 'positive' AND m.lead_id IS NOT NULL
   AND substr(m.thread_id, 1, 10) <> 'dazl-test-' AND coalesce(l.source_kind, '') <> 'test'
   AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.tenant_id = m.tenant_id AND d.thread_id = m.thread_id)
   AND NOT EXISTS (SELECT 1 FROM inbound_messages x WHERE x.tenant_id = m.tenant_id AND x.thread_id = m.thread_id
                   AND x.classification IN ('opt_out', 'negative') AND x.received_at >= m.received_at)
   AND NOT EXISTS (SELECT 1 FROM followup_threads f WHERE f.tenant_id = m.tenant_id AND f.thread_id = m.thread_id
                   AND f.stopped IN ('opt_out', 'negative', 'bounce', 'suppressed')) -- lib/outreach/needs-owner.ts SETTLED_STOPS
   AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.tenant_id = m.tenant_id AND lower(s.email) = lower(m.from_email))
 ORDER BY m.received_at, m.gmail_id
 LIMIT ?`

export type RouteResult = { created: number; assigned: number; unassigned: number; rules: number }

// Turns this workspace's new qualified conversations into deals, at most `limit` conversations per call. Idempotent:
// a conversation that already has a deal is never selected, and the insert is ON CONFLICT DO NOTHING on (tenant,
// thread), so two concurrent runs create one deal. Each created deal gets its first history event and an audit event
// (actor: the router service) in the same transaction.
export async function routeQualifiedConversations(db: Db, tenantId: string, o: { now?: number; limit?: number; fence?: Fence; correlationId?: string | null } = {}): Promise<RouteResult> {
  const now = o.now ?? nowS()
  const limit = Math.max(1, Math.min(o.limit ?? 200, 1000))
  return db.tx(function* (t) {
    if (o.fence) yield* o.fence(t)
    const rules = (yield* t.all<Rule>(ACTIVE_RULES, [tenantId])).map(r => ({ ...r, position: Number(r.position), sla_hours: num(r.sla_hours), active: Number(r.active) }))
    const out: RouteResult = { created: 0, assigned: 0, unassigned: 0, rules: rules.length }
    if (rules.length === 0) return out // the pipeline is not set up for this workspace
    const owners = yield* dealOwners(t, tenantId)
    const seen = new Set<string>()
    for (const c of yield* t.all<{ thread_id: string; lead_id: string; from_email: string; received_at: number; company: string | null; name: string | null; job_id: string }>(CANDIDATES, [tenantId, limit])) {
      if (seen.has(c.thread_id)) continue
      seen.add(c.thread_id)
      const pick = pickOwner(rules, owners, c)
      const title = (c.company || c.name || domainOf(c.from_email) || 'Conversation').slice(0, 200)
      const d: Deal = {
        id: newId(), thread_id: c.thread_id.slice(0, 200), lead_id: c.lead_id, title, owner_id: pick.rule?.owner_id ?? null, stage: 'new',
        amount_minor: null, currency: null, close_date: null, close_reason: null, close_note: null, rule_id: pick.rule?.id ?? null, route_reason: pick.reason,
        sla_due_at: pick.rule?.sla_hours ? now + pick.rule.sla_hours * 3600 : null, created_at: now, updated_at: now, closed_at: null, version: 1,
      }
      const ins = yield* t.run(`INSERT INTO deals (id, tenant_id, thread_id, lead_id, title, owner_id, stage, rule_id, route_reason, sla_due_at, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, 1) ON CONFLICT (tenant_id, thread_id) DO NOTHING`,
      [d.id, tenantId, d.thread_id, d.lead_id, d.title, d.owner_id, d.rule_id, d.route_reason, d.sla_due_at, now, now])
      if (ins.changes !== 1) continue
      yield* appendEvent(t, tenantId, d, 'created', null, ROUTER_ACTOR, now)
      yield* recordTx(t, { tenantId, actorId: ROUTER_ACTOR, actorKind: 'service', action: 'deal.routed', resourceType: 'deal', resourceId: d.id,
        summary: { route: d.route_reason, rule: d.rule_id, assigned: d.owner_id !== null }, correlationId: o.correlationId ?? null }, now)
      out.created++
      if (d.owner_id) out.assigned++; else out.unassigned++
    }
    return out
  })
}

// Workspaces the scheduled tick routes for: those with an active rule and at least one positive reply not yet a deal.
// A cheap prefilter only: routeQualifiedConversations applies the full qualification, so a listed workspace whose positive
// threads are all unqualified (opt-out, suppressed, fixture) is routed to no effect.
export async function routingTenants(db: Db): Promise<string[]> {
  const rows = await db.all<{ tenant_id: string }>(`SELECT DISTINCT r.tenant_id AS tenant_id FROM deal_routing_rules r
    WHERE r.active = 1 AND EXISTS (SELECT 1 FROM inbound_messages m WHERE m.tenant_id = r.tenant_id AND m.classification = 'positive' AND m.lead_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.tenant_id = m.tenant_id AND d.thread_id = m.thread_id))
    ORDER BY r.tenant_id`)
  return rows.map(r => r.tenant_id)
}

// ---- changes -------------------------------------------------------------------------------------------------------

export interface DealChange { stage?: Stage; owner_id?: string | null; amount_minor?: number | null; currency?: string | null; close_date?: string | null; close_reason?: string | null; close_note?: string | null }
export type ChangeError = 'not_found' | 'conflict' | 'no_change' | 'bad_request' | 'bad_transition' | 'reason_required' | 'bad_reason' | 'amount_required' | 'bad_amount' | 'bad_currency' | 'bad_date' | 'owner_not_member'
export type ChangeResult = { ok: true; deal: Deal } | { ok: false; error: ChangeError }

const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s

// Parses a PATCH body into a change; anything unknown or malformed is refused, never ignored.
export function parseChange(b: unknown): DealChange | null {
  if (!b || typeof b !== 'object') return null
  const o = b as Record<string, unknown>, c: DealChange = {}
  for (const k of Object.keys(o)) if (!['version', 'stage', 'owner_id', 'amount_minor', 'currency', 'close_date', 'close_reason', 'close_note'].includes(k)) return null
  if ('stage' in o) { if (!isStage(o.stage)) return null; c.stage = o.stage }
  if ('owner_id' in o) { if (o.owner_id !== null && (typeof o.owner_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.owner_id))) return null; c.owner_id = o.owner_id as string | null }
  if ('amount_minor' in o) { if (o.amount_minor !== null && typeof o.amount_minor !== 'number') return null; c.amount_minor = o.amount_minor as number | null }
  if ('currency' in o) { if (o.currency !== null && typeof o.currency !== 'string') return null; c.currency = o.currency as string | null }
  if ('close_date' in o) { if (o.close_date !== null && typeof o.close_date !== 'string') return null; c.close_date = o.close_date as string | null }
  if ('close_reason' in o) { if (o.close_reason !== null && typeof o.close_reason !== 'string') return null; c.close_reason = o.close_reason as string | null }
  if ('close_note' in o) { if (o.close_note !== null && typeof o.close_note !== 'string') return null; c.close_note = o.close_note as string | null }
  return c
}

// The deal after `c`, or why the change is refused. Pure. Rules:
//   - open stages move freely among themselves (forward or back); won/lost need a reason from that outcome's list;
//     won also needs an amount and currency, so won revenue always has a value to report
//   - a closed deal changes only by reopening it to an open stage (reason, note, closed time, close date and amount are cleared)
//   - amount and currency are set together: integer minor units, ISO 4217 shape
export function applyChange(d: Deal, c: DealChange, owners: Set<string>, now: number): { deal: Deal; kind: 'changed' | 'closed' | 'reopened' } | ChangeError {
  const next: Deal = { ...d }
  const wasOpen = isOpen(d.stage)
  if (c.owner_id !== undefined) { if (c.owner_id !== null && !owners.has(c.owner_id)) return 'owner_not_member'; next.owner_id = c.owner_id }
  if (c.amount_minor !== undefined || c.currency !== undefined) {
    const a = c.amount_minor !== undefined ? c.amount_minor : d.amount_minor
    const cur = c.currency !== undefined ? (c.currency === null ? null : c.currency.trim().toUpperCase()) : d.currency
    if (a !== null && (!Number.isSafeInteger(a) || a < 0 || a > MAX_AMOUNT)) return 'bad_amount'
    if (cur !== null && !/^[A-Z]{3}$/.test(cur)) return 'bad_currency'
    if ((a === null) !== (cur === null)) return a === null ? 'bad_amount' : 'bad_currency'
    next.amount_minor = a; next.currency = cur
  }
  if (c.close_date !== undefined) { if (c.close_date !== null && !validDate(c.close_date)) return 'bad_date'; next.close_date = c.close_date }
  if (c.close_note !== undefined) next.close_note = c.close_note === null ? null : c.close_note.trim().slice(0, 200) || null
  let kind: 'changed' | 'closed' | 'reopened' = 'changed'
  const to = c.stage ?? d.stage
  // A closed deal's facts are frozen with its outcome: it changes only by reopening it to an open stage, and won <-> lost
  // directly is refused too (reopen first), so every outcome in the history is a deliberate close.
  if (!wasOpen && !isOpen(to)) return 'bad_transition'
  if (to !== d.stage) {
    if (!wasOpen) {
      // Reopening clears every fact of the old outcome: its close date and (won) amount must not linger on an open deal
      // and count as open money in the report. Values supplied in this same change are kept (they are fresh).
      kind = 'reopened'; next.close_reason = null; next.close_note = c.close_note !== undefined ? next.close_note : null; next.closed_at = null
      if (c.close_date === undefined) next.close_date = null
      if (c.amount_minor === undefined && c.currency === undefined) { next.amount_minor = null; next.currency = null }
    }
    if (!isOpen(to)) {
      const reasons: readonly string[] = to === 'won' ? WON_REASONS : LOST_REASONS
      if (!c.close_reason) return 'reason_required'
      if (!reasons.includes(c.close_reason)) return 'bad_reason'
      if (to === 'won' && (next.amount_minor === null || next.currency === null)) return 'amount_required'
      next.close_reason = c.close_reason; next.closed_at = now; kind = 'closed'
    }
    next.stage = to
  }
  if (isOpen(next.stage) && c.close_reason) return 'bad_transition' // a reason belongs to a close; never set on an open deal
  const same = (['owner_id', 'stage', 'amount_minor', 'currency', 'close_date', 'close_reason', 'close_note'] as const).every(k => next[k] === d[k])
  if (same) return 'no_change'
  next.version = d.version + 1; next.updated_at = now
  return { deal: next, kind }
}

// One change to one deal of this workspace, as `actorId`, only if the caller saw the current version (optimistic
// concurrency: a stale edit is refused with 'conflict', never merged). The new state, its history snapshot and the
// audit event commit together or not at all.
export async function changeDeal(db: Db, tenantId: string, actorId: string, dealId: string, version: number, c: DealChange, o: { now?: number; correlationId?: string | null } = {}): Promise<ChangeResult> {
  const now = o.now ?? nowS()
  return db.tx(function* (t): TxBody<ChangeResult> {
    const r = yield* t.get<Record<string, unknown>>(`SELECT ${DEAL_COLS} FROM deals WHERE id = ? AND tenant_id = ?`, [dealId, tenantId])
    if (!r) return { ok: false, error: 'not_found' }
    const d = dealRow(r)
    if (d.version !== version) return { ok: false, error: 'conflict' }
    const owners = c.owner_id !== undefined ? yield* dealOwners(t, tenantId) : new Set<string>()
    const a = applyChange(d, c, owners, now)
    if (typeof a === 'string') return { ok: false, error: a }
    const n = a.deal
    const u = yield* t.run(`UPDATE deals SET owner_id = ?, stage = ?, amount_minor = ?, currency = ?, close_date = ?, close_reason = ?, close_note = ?, closed_at = ?, updated_at = ?, version = ?
      WHERE id = ? AND tenant_id = ? AND version = ?`,
    [n.owner_id, n.stage, n.amount_minor, n.currency, n.close_date, n.close_reason, n.close_note, n.closed_at, now, n.version, dealId, tenantId, d.version])
    if (u.changes !== 1) return { ok: false, error: 'conflict' }
    yield* appendEvent(t, tenantId, n, a.kind, d.stage, actorId, now)
    yield* recordTx(t, { tenantId, actorId, action: `deal.${a.kind}`, resourceType: 'deal', resourceId: dealId, correlationId: o.correlationId ?? null,
      summary: { from: d.stage, to: n.stage, owner_changed: n.owner_id !== d.owner_id, amount_changed: n.amount_minor !== d.amount_minor || n.currency !== d.currency, reason: n.close_reason, version: n.version } }, now)
    return { ok: true, deal: n }
  })
}

// ---- reads ---------------------------------------------------------------------------------------------------------

export type DealListRow = Deal & { owner_label: string | null; owner_is_member: boolean; company: string | null; job_id: string | null; sla_overdue: boolean }

// This workspace's deals, newest first. The owner's label comes only from a CURRENT membership of this workspace, so a
// removed member's or another workspace's account is never named.
const LIST_DEALS = `SELECT d.id, d.thread_id, d.lead_id, d.title, d.owner_id, d.stage, d.amount_minor, d.currency, d.close_date, d.close_reason, d.close_note,
      d.rule_id, d.route_reason, d.sla_due_at, d.created_at, d.updated_at, d.closed_at, d.version,
      mm.member_id AS member_id, u.name AS owner_name, u.email AS owner_email, l.company AS company, l.scan_job_id AS job_id
    FROM deals d
    LEFT JOIN memberships mm ON mm.tenant_id = d.tenant_id AND mm.member_id = d.owner_id
    LEFT JOIN users u ON u.id = mm.member_id
    LEFT JOIN leads l ON l.id = d.lead_id AND EXISTS (SELECT 1 FROM scan_jobs j WHERE j.id = l.scan_job_id AND j.user_id = d.tenant_id)
    WHERE d.tenant_id = ?
    ORDER BY d.created_at DESC, d.id DESC LIMIT ?`

// This workspace's deals, newest first (at most 500). The owner's label comes only from a CURRENT membership of this
// workspace, so a removed member's or another workspace's account is never named. owner 'none' = unassigned.
export async function listDeals(db: Db, tenantId: string, q: { stage?: Stage | null; owner?: string | null; limit?: number; now?: number } = {}): Promise<DealListRow[]> {
  const now = q.now ?? nowS()
  const rows = await db.all<Record<string, unknown>>(LIST_DEALS, [tenantId, Math.max(1, Math.min(q.limit ?? 200, 500))])
  return rows.map(r => {
    const d = dealRow(r)
    return { ...d, owner_label: r.member_id ? String(r.owner_name || r.owner_email || r.member_id) : null, owner_is_member: !!r.member_id, company: (r.company as string | null) ?? null,
      job_id: (r.job_id as string | null) ?? null, sla_overdue: d.stage === 'new' && d.sla_due_at !== null && d.sla_due_at < now }
  }).filter(d => (!q.stage || d.stage === q.stage) && (!q.owner || (q.owner === 'none' ? d.owner_id === null : d.owner_id === q.owner)))
}

export async function getDeal(db: Db, tenantId: string, dealId: string): Promise<{ deal: Deal; history: DealEvent[] } | null> {
  const r = await db.get<Record<string, unknown>>(`SELECT ${DEAL_COLS} FROM deals WHERE id = ? AND tenant_id = ?`, [dealId, tenantId])
  if (!r) return null
  const history = (await db.all<Record<string, unknown>>(`SELECT seq, kind, from_stage, stage, owner_id, amount_minor, currency, close_reason, actor_id, at
    FROM deal_stage_events WHERE tenant_id = ? AND deal_id = ? ORDER BY seq`, [tenantId, dealId])).map(eventRow)
  return { deal: dealRow(r), history }
}

// The deal's state at time `at` from its history alone: its latest snapshot at or before `at`, or null before it existed.
export function stateAt(history: DealEvent[], at: number): DealEvent | null {
  let s: DealEvent | null = null
  for (const e of history) if (e.at <= at && (!s || e.seq > s.seq)) s = e
  return s
}

// The members who may own deals, for the owner picker. Labels from this workspace's memberships only.
export async function dealOwnerChoices(db: Db, tenantId: string): Promise<{ id: string; label: string; role: string }[]> {
  const rows = await db.all<{ member_id: string; name: string | null; email: string | null; role: string }>(`SELECT m.member_id, u.name, u.email, m.role FROM memberships m
    JOIN users u ON u.id = m.member_id WHERE m.tenant_id = ? AND m.role IN ('owner', 'admin', 'operator') ORDER BY m.created_at, m.member_id`, [tenantId])
  return rows.map(r => ({ id: r.member_id, label: r.name || r.email || r.member_id, role: r.role }))
}

// ---- rules ---------------------------------------------------------------------------------------------------------

export type RuleError = 'bad_request' | 'owner_not_member' | 'too_many_rules' | 'not_found'
export interface RuleInput { match_kind: MatchKind; match_value: string; owner_id: string; sla_hours: number | null }

export function parseRule(b: unknown): RuleInput | null {
  if (!b || typeof b !== 'object') return null
  const o = b as Record<string, unknown>
  if (typeof o.match_kind !== 'string' || !(MATCH_KINDS as readonly string[]).includes(o.match_kind)) return null
  const kind = o.match_kind as MatchKind
  const value = kind === 'any' ? '' : typeof o.match_value === 'string' ? o.match_value.trim().toLowerCase() : null
  if (value === null) return null
  if (kind === 'play' && !/^[a-z0-9_-]{1,64}$/.test(value)) return null
  if (kind === 'domain' && !/^(?=.{1,200}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) return null
  if (typeof o.owner_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.owner_id)) return null
  const sla = o.sla_hours === undefined || o.sla_hours === null ? null : o.sla_hours
  if (sla !== null && (typeof sla !== 'number' || !Number.isInteger(sla) || sla < 1 || sla > 720)) return null
  return { match_kind: kind, match_value: kind === 'play' ? String(o.match_value).trim() : value, owner_id: o.owner_id, sla_hours: sla as number | null }
}

export async function listRules(db: Db, tenantId: string): Promise<Rule[]> {
  return (await db.all<Rule>('SELECT id, position, match_kind, match_value, owner_id, sla_hours, active, created_by, created_at FROM deal_routing_rules WHERE tenant_id = ? ORDER BY active DESC, position, created_at, id', [tenantId]))
    .map(r => ({ ...r, position: Number(r.position), sla_hours: num(r.sla_hours), active: Number(r.active), created_at: Number(r.created_at) }))
}

// Appends a rule at the end of the order. A play rule must name one of this workspace's own plays.
export async function addRule(db: Db, tenantId: string, actorId: string, r: RuleInput, o: { now?: number; correlationId?: string | null } = {}): Promise<{ ok: true; rule: Rule } | { ok: false; error: RuleError }> {
  const now = o.now ?? nowS()
  return db.tx(function* (t): TxBody<{ ok: true; rule: Rule } | { ok: false; error: RuleError }> {
    if (!(yield* dealOwners(t, tenantId)).has(r.owner_id)) return { ok: false, error: 'owner_not_member' }
    if (r.match_kind === 'play' && !(yield* t.get('SELECT 1 AS x FROM scan_jobs WHERE id = ? AND user_id = ?', [r.match_value, tenantId]))) return { ok: false, error: 'bad_request' }
    const n = Number((yield* t.get<{ n: number }>('SELECT count(*) AS n FROM deal_routing_rules WHERE tenant_id = ? AND active = 1', [tenantId]))?.n ?? 0)
    if (n >= MAX_ACTIVE_RULES) return { ok: false, error: 'too_many_rules' }
    const pos = Number((yield* t.get<{ p: number | null }>('SELECT max(position) AS p FROM deal_routing_rules WHERE tenant_id = ?', [tenantId]))?.p ?? 0) + 1
    const rule: Rule = { id: newId(), position: pos, match_kind: r.match_kind, match_value: r.match_value, owner_id: r.owner_id, sla_hours: r.sla_hours, active: 1, created_by: actorId, created_at: now }
    yield* t.run('INSERT INTO deal_routing_rules (id, tenant_id, position, match_kind, match_value, owner_id, sla_hours, active, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
      [rule.id, tenantId, pos, rule.match_kind, rule.match_value, rule.owner_id, rule.sla_hours, actorId.slice(0, 80), now])
    yield* recordTx(t, { tenantId, actorId, action: 'deal_rule.added', resourceType: 'deal_rule', resourceId: rule.id, correlationId: o.correlationId ?? null,
      summary: { match_kind: rule.match_kind, position: pos, sla_hours: rule.sla_hours } }, now)
    return { ok: true, rule }
  })
}

export async function deactivateRule(db: Db, tenantId: string, actorId: string, ruleId: string, o: { now?: number; correlationId?: string | null } = {}): Promise<boolean> {
  const now = o.now ?? nowS()
  return db.tx(function* (t) {
    const u = yield* t.run('UPDATE deal_routing_rules SET active = 0 WHERE id = ? AND tenant_id = ? AND active = 1', [ruleId, tenantId])
    if (u.changes !== 1) return false
    yield* recordTx(t, { tenantId, actorId, action: 'deal_rule.deactivated', resourceType: 'deal_rule', resourceId: ruleId, correlationId: o.correlationId ?? null }, now)
    return true
  })
}

// ---- report --------------------------------------------------------------------------------------------------------

export const REPORT_DEFINITIONS = {
  deal: 'one canonical deal per qualified conversation (unique per workspace and thread); counts are deals, never messages or replies',
  qualified_conversation: "a reply thread with a rule-classified 'positive' reply on one of this workspace's leads, no later opt-out or no, not settled and not suppressed; not human-confirmed",
  attribution: 'a deal is attributed only to the conversation it was routed from (its thread, lead and play); no multi-touch credit, no causal claim',
  amounts: 'integer minor units per ISO currency; never summed across currencies (no FX conversion); open deals without an amount count in deals but add no value',
  as_of: 'every figure is rebuilt from the append-only stage history as of this time; reconciliation compares the rebuild at now with the deals table',
  cohort: 'deals grouped by the UTC month they were created; outcome is the state as of the report time',
} as const

type Money = Record<string, number>
export interface StageRow { stage: Stage; deals: number; amounts: Money }
export interface CohortRow { month: string; deals: number; open: number; won: number; lost: number; won_amounts: Money }
export interface PipelineReport {
  as_of: number
  definitions: typeof REPORT_DEFINITIONS
  deals: number
  by_stage: StageRow[]
  won: { deals: number; amounts: Money; by_reason: Record<string, number> }
  lost: { deals: number; by_reason: Record<string, number> }
  open: { deals: number; unassigned: number; amounts: Money; without_amount: number }
  sla_overdue: number
  cohorts: CohortRow[]
  reconciliation: { checked: boolean; deals_table: number | null; mismatched: number | null }
}

const add = (m: Money, cur: string | null, amt: number | null) => { if (cur !== null && amt !== null) m[cur] = (m[cur] ?? 0) + amt }
const month = (s: number) => new Date(s * 1000).toISOString().slice(0, 7)

// The pipeline as of `asOf` (default now), from the history alone. Each deal contributes exactly one state (its latest
// snapshot at or before asOf), so the stage counts always sum to the deal total. When asOf is now, the rebuild is
// checked against the canonical deals table: `mismatched` counts deals whose current row and latest snapshot differ.
export async function pipelineReport(db: Db, tenantId: string, o: { asOf?: number; now?: number } = {}): Promise<PipelineReport> {
  const now = o.now ?? nowS()
  const asOf = Math.min(o.asOf ?? now, now)
  const events = (await db.all<Record<string, unknown> & { deal_id: string }>(`SELECT deal_id, seq, kind, from_stage, stage, owner_id, amount_minor, currency, close_reason, actor_id, at
    FROM deal_stage_events WHERE tenant_id = ? AND at <= ? ORDER BY deal_id, seq`, [tenantId, asOf])).map(r => ({ deal_id: r.deal_id, ...eventRow(r) }))
  const latest = new Map<string, DealEvent>(), created = new Map<string, number>()
  for (const e of events) {
    if (!created.has(e.deal_id) || e.at < created.get(e.deal_id)!) created.set(e.deal_id, e.at)
    const cur = latest.get(e.deal_id)
    if (!cur || e.seq > cur.seq) latest.set(e.deal_id, e)
  }
  const slaRows = await db.all<{ id: string; sla_due_at: number | null }>('SELECT id, sla_due_at FROM deals WHERE tenant_id = ? AND sla_due_at IS NOT NULL', [tenantId])
  const sla = new Map(slaRows.map(r => [r.id, Number(r.sla_due_at)]))
  const byStage = new Map<Stage, StageRow>(STAGES.map(s => [s, { stage: s, deals: 0, amounts: {} }]))
  const rep: PipelineReport = {
    as_of: asOf, definitions: REPORT_DEFINITIONS, deals: latest.size, by_stage: [],
    won: { deals: 0, amounts: {}, by_reason: {} }, lost: { deals: 0, by_reason: {} }, open: { deals: 0, unassigned: 0, amounts: {}, without_amount: 0 },
    sla_overdue: 0, cohorts: [], reconciliation: { checked: false, deals_table: null, mismatched: null },
  }
  const cohorts = new Map<string, CohortRow>()
  for (const [id, s] of latest) {
    const row = byStage.get(s.stage)!
    row.deals++; add(row.amounts, s.currency, s.amount_minor)
    const m = month(created.get(id)!)
    const c = cohorts.get(m) ?? { month: m, deals: 0, open: 0, won: 0, lost: 0, won_amounts: {} }
    c.deals++
    if (s.stage === 'won') { rep.won.deals++; add(rep.won.amounts, s.currency, s.amount_minor); rep.won.by_reason[s.close_reason ?? 'unknown'] = (rep.won.by_reason[s.close_reason ?? 'unknown'] ?? 0) + 1; c.won++; add(c.won_amounts, s.currency, s.amount_minor) }
    else if (s.stage === 'lost') { rep.lost.deals++; rep.lost.by_reason[s.close_reason ?? 'unknown'] = (rep.lost.by_reason[s.close_reason ?? 'unknown'] ?? 0) + 1; c.lost++ }
    else {
      rep.open.deals++; c.open++
      if (s.owner_id === null) rep.open.unassigned++
      if (s.amount_minor === null) rep.open.without_amount++; else add(rep.open.amounts, s.currency, s.amount_minor)
      const due = sla.get(id)
      if (s.stage === 'new' && due !== undefined && due < asOf) rep.sla_overdue++
    }
    cohorts.set(m, c)
  }
  rep.by_stage = [...byStage.values()]
  rep.cohorts = [...cohorts.values()].sort((a, b) => a.month.localeCompare(b.month))
  if (asOf === now) {
    const rows = await db.all<Record<string, unknown>>(`SELECT ${DEAL_COLS} FROM deals WHERE tenant_id = ?`, [tenantId])
    let mismatched = 0
    for (const r of rows.map(dealRow)) {
      const s = latest.get(r.id)
      if (!s || s.seq !== r.version || s.stage !== r.stage || s.owner_id !== r.owner_id || s.amount_minor !== r.amount_minor || s.currency !== r.currency || s.close_reason !== r.close_reason) mismatched++
    }
    for (const id of latest.keys()) if (!rows.some(r => r.id === id)) mismatched++
    rep.reconciliation = { checked: true, deals_table: rows.length, mismatched }
  }
  return rep
}
