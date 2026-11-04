// Reasoned lead feedback (#385; docs/design/lead-feedback.md). A tenant's explicit verdict on one of its leads is stored
// at the level its reason names and read back by every later run, so an entity the tenant rejected is not brought back.
//
//  - Levels. wrong industry / wrong location / competitor / existing relationship / not useful -> the ACCOUNT is dropped
//    from later runs. wrong person -> that PERSON (name and contact) is stripped; the company may come back with someone
//    else. wrong timing -> that EVENT is held: the same day, an older day, a mirror of it (another URL, same day) and an
//    undated one; only a strictly later event day is a new relevant event and passes.
//  - Hard rules apart from learned preferences. Rejections are the tenant's own explicit rules and are enforced. What is
//    LEARNED from outcomes (source yield, proposed memory exclusions) only orders or proposes: it never drops a lead,
//    never relaxes a gate, and changes memory only when the tenant applies a proposal that is still current.
//  - Explainable, reversible, versioned. Every drop names the feedback id and reason; resetFeedback keeps the row with
//    why it was reset. Each verdict takes the tenant's next version ((tenant_id, version) is unique).
//  - Tenant-isolated: every read and write takes the tenant.
//  - Fail closed: a store that exists but cannot be read is UNKNOWN, never "no feedback" (the runner holds every
//    candidate). A missing table is an older deploy: no feedback was ever recorded.
//  - Passive signals never train. A quarantine without a structured reason teaches nothing; an opted-out contact never
//    joins a positive cohort; an approve/draft is not an acceptance.
//  - Keys, until the canonical account graph (#364): an account by its explicit domain when both sides have one (a
//    same-name business on another domain is someone else), else by its company key; a person by name or address.
import { randomBytes } from 'node:crypto'
import type { Db, Tx, TxBody } from '../db/client.ts'
import { companyKey } from './evidence.ts'
import { QUARANTINE_REASON_MAX } from './quarantine.ts'
import { readMemory, writeMemory, type Memory } from '../memory.ts'

export const REJECT_REASONS = ['wrong_industry', 'wrong_location', 'competitor', 'existing_relationship', 'not_useful', 'wrong_person', 'wrong_timing'] as const
export type RejectReason = typeof REJECT_REASONS[number]
export type Level = 'account' | 'person' | 'event'
export const LEVEL_OF: Record<RejectReason, Level> = { wrong_industry: 'account', wrong_location: 'account', competitor: 'account', existing_relationship: 'account', not_useful: 'account', wrong_person: 'person', wrong_timing: 'event' }
export const isRejectReason = (v: unknown): v is RejectReason => typeof v === 'string' && (REJECT_REASONS as readonly string[]).includes(v)

// A verdict that cannot be recorded as asked. `code` is what a route returns; nothing was written.
export class FeedbackError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.code = code } }
// The store exists but could not be read: what the tenant rejected is unknown.
export class FeedbackUnreadable extends Error {}

export interface FeedbackRow {
  id: string; tenant_id: string; version: number; verdict: 'accept' | 'reject'; level: Level; reason: RejectReason | null
  company_key: string; domain: string | null; person_name: string | null; person_contact: string | null; event_date: string | null
  source_host: string | null; signal_kind: string | null; lead_id: string | null; job_id: string | null; actor_id: string | null
  note: string | null; created_at: number; reset_at: number | null; reset_reason: string | null
}
const COLS = 'id, tenant_id, version, verdict, level, reason, company_key, domain, person_name, person_contact, event_date, source_host, signal_kind, lead_id, job_id, actor_id, note, created_at, reset_at, reset_reason'
const num = (r: FeedbackRow): FeedbackRow => ({ ...r, version: Number(r.version), created_at: Number(r.created_at), reset_at: r.reset_at == null ? null : Number(r.reset_at) })

// SQLite DDL (run by migrateAllSqlite). Postgres: lib/db/migrations/pg/0044_lead_feedback.sql.
export const FEEDBACK_DDL = `
  CREATE TABLE IF NOT EXISTS lead_feedback (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('accept', 'reject')),
    level TEXT NOT NULL CHECK (level IN ('account', 'person', 'event')),
    reason TEXT CHECK (reason IS NULL OR reason IN ('wrong_industry', 'wrong_location', 'competitor', 'existing_relationship', 'not_useful', 'wrong_person', 'wrong_timing')),
    company_key TEXT NOT NULL,
    domain TEXT,
    person_name TEXT,
    person_contact TEXT,
    event_date TEXT,
    source_host TEXT,
    signal_kind TEXT,
    lead_id TEXT,
    job_id TEXT,
    actor_id TEXT,
    note TEXT CHECK (note IS NULL OR length(note) <= 300),
    created_at INTEGER NOT NULL,
    reset_at INTEGER,
    reset_reason TEXT CHECK (reset_reason IS NULL OR length(reset_reason) <= 200)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS lead_feedback_version ON lead_feedback (tenant_id, version);
  CREATE INDEX IF NOT EXISTS lead_feedback_active ON lead_feedback (tenant_id, reset_at);
`
export function migrateFeedback(db: { exec(sql: string): unknown }): void { db.exec(FEEDBACK_DDL) }

const clean = (s: unknown, max: number) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''
export const normDomain = (d: string | null | undefined): string | null => { const h = (d ?? '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0]; return h.includes('.') ? h : null }
const normName = (s: string | null | undefined) => clean(s ?? '', 150).toLowerCase() || null
const normContact = (s: string | null | undefined) => clean(s ?? '', 254).toLowerCase() || null
const hostOf = (u: string | null | undefined) => { try { return u ? new URL(u).hostname.replace(/^www\./, '').toLowerCase() : null } catch { return null } }
const DAY = /^\d{4}-\d{2}-\d{2}$/

type LeadRow = { id: string; company: string; company_domain: string | null; name: string; contact: string | null; event_date: string | null; source_url: string; signal_kind: string | null; scan_job_id: string; quarantined_at: number | null }
const LEAD_SQL = 'SELECT l.id, l.company, l.company_domain, l.name, l.contact, l.event_date, l.source_url, l.signal_kind, l.scan_job_id, l.quarantined_at FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?'

export interface VerdictInput { verdict: 'accept' | 'reject'; reason?: unknown; note?: unknown; person?: unknown; actorId?: string | null }
// Validates a verdict against the lead and builds its row (no write). Throws FeedbackError with a route code.
function buildRow(tenantId: string, lead: LeadRow, input: VerdictInput, now: number): Omit<FeedbackRow, 'version'> {
  if (input.verdict !== 'accept' && input.verdict !== 'reject') throw new FeedbackError('invalid_verdict', 'verdict is accept or reject')
  if (input.verdict === 'reject' && !isRejectReason(input.reason)) throw new FeedbackError('invalid_feedback_reason', `a rejection needs one of: ${REJECT_REASONS.join(', ')}`)
  if (input.verdict === 'accept' && input.reason !== undefined && input.reason !== null) throw new FeedbackError('invalid_feedback_reason', 'an acceptance carries no rejection reason')
  if (input.person !== undefined && input.person !== null && typeof input.person !== 'string') throw new FeedbackError('invalid_person', 'person is a name or an address')
  const key = companyKey(lead.company)
  if (key.length < 2) throw new FeedbackError('no_company', 'the lead names no company')
  const reason = input.verdict === 'reject' ? input.reason as RejectReason : null
  const level: Level = reason ? LEVEL_OF[reason] : 'account'
  let person_name: string | null = null, person_contact: string | null = null
  if (level === 'person') {
    const given = clean(input.person, 254)
    if (given) { if (given.includes('@')) person_contact = given.toLowerCase(); else person_name = given.toLowerCase() }
    else { person_name = normName(lead.name); person_contact = normContact(lead.contact) }
    if (!person_name && !person_contact) throw new FeedbackError('person_required', 'a wrong-person rejection needs the person: the lead names nobody')
  }
  if (level === 'event' && !(lead.event_date && DAY.test(lead.event_date))) throw new FeedbackError('event_date_required', 'a wrong-timing rejection needs a dated event on the lead')
  return {
    id: randomBytes(12).toString('hex'), tenant_id: tenantId, verdict: input.verdict, level, reason,
    company_key: key, domain: normDomain(lead.company_domain), person_name, person_contact, event_date: level === 'event' ? lead.event_date : null,
    source_host: hostOf(lead.source_url), signal_kind: lead.signal_kind ?? null, lead_id: lead.id, job_id: lead.scan_job_id, actor_id: input.actorId ?? null,
    note: clean(input.note, 300) || null, created_at: Math.floor(now / 1000), reset_at: null, reset_reason: null,
  }
}

const isUnique = (e: unknown) => /unique|duplicate|constraint/i.test(e instanceof Error ? e.message : String(e))
// Inside a transaction: the next version for the tenant, then the insert. Two writers that compute the same version
// (Postgres read committed) collide on the unique index; the caller retries the whole transaction.
function* insertRow(t: Tx, row: Omit<FeedbackRow, 'version'>): TxBody<FeedbackRow> {
  const v = yield* t.get<{ v: number | string | null }>('SELECT MAX(version) AS v FROM lead_feedback WHERE tenant_id = ?', [row.tenant_id])
  const version = Number(v?.v ?? 0) + 1
  yield* t.run(`INSERT INTO lead_feedback (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.tenant_id, version, row.verdict, row.level, row.reason, row.company_key, row.domain, row.person_name, row.person_contact, row.event_date, row.source_host, row.signal_kind, row.lead_id, row.job_id, row.actor_id, row.note, row.created_at, null, null])
  return { ...row, version }
}
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn() } catch (e) { if (e instanceof FeedbackError || attempt >= 12 || !isUnique(e)) throw e }
  }
}

// Records an explicit verdict on one of the tenant's leads (no quarantine). Another tenant's lead is unknown here.
export async function recordFeedback(db: Db, tenantId: string, leadId: string, input: VerdictInput, now = Date.now()): Promise<FeedbackRow> {
  return withRetry(() => db.tx(function* (t) {
    const lead = yield* t.get<LeadRow>(LEAD_SQL, [leadId, tenantId])
    if (!lead) throw new FeedbackError('not_found', 'no such lead')
    return yield* insertRow(t, buildRow(tenantId, lead, input, now))
  }))
}

// Reject = quarantine + reasoned feedback, in ONE transaction: everything is validated before anything is written, and
// a failed insert leaves the lead unquarantined. 'not_found' for another tenant's lead.
export async function rejectLead(db: Db, tenantId: string, leadId: string, input: { reason: unknown; note?: unknown; person?: unknown; quarantineReason?: string; actorId?: string | null }, now = Date.now()): Promise<{ status: 'not_found' } | { status: 'rejected'; feedback: FeedbackRow }> {
  return withRetry(() => db.tx(function* (t) {
    const lead = yield* t.get<LeadRow>(LEAD_SQL, [leadId, tenantId])
    if (!lead) return { status: 'not_found' as const }
    const row = buildRow(tenantId, lead, { verdict: 'reject', reason: input.reason, note: input.note, person: input.person, actorId: input.actorId }, now)
    const why = clean(input.quarantineReason ?? '', QUARANTINE_REASON_MAX) || 'Quarantined by you'
    yield* t.run('UPDATE leads SET quarantined_at = ?, quarantine_reason = ? WHERE id = ?', [Math.floor(now / 1000), why, lead.id])
    return { status: 'rejected' as const, feedback: yield* insertRow(t, row) }
  }))
}

// Release = unquarantine + reset every active verdict that lead wrote, in one transaction. The rows stay as history.
export async function releaseLead(db: Db, tenantId: string, leadId: string, now = Date.now()): Promise<{ status: 'not_found' | 'unchanged' } | { status: 'released'; reset: number }> {
  return db.tx(function* (t) {
    const lead = yield* t.get<LeadRow>(LEAD_SQL, [leadId, tenantId])
    if (!lead) return { status: 'not_found' as const }
    const r = yield* t.run("UPDATE lead_feedback SET reset_at = ?, reset_reason = 'lead released' WHERE tenant_id = ? AND lead_id = ? AND verdict = 'reject' AND reset_at IS NULL", [Math.floor(now / 1000), tenantId, lead.id])
    if (lead.quarantined_at == null && r.changes === 0) return { status: 'unchanged' as const }
    yield* t.run('UPDATE leads SET quarantined_at = NULL, quarantine_reason = NULL WHERE id = ?', [lead.id])
    return { status: 'released' as const, reset: r.changes }
  })
}

// Reverses one verdict; the row is kept with why. Only the owning tenant can.
export async function resetFeedback(db: Db, tenantId: string, id: string, reason: unknown, now = Date.now()): Promise<boolean> {
  const why = clean(reason, 200)
  if (!why) throw new FeedbackError('reset_reason_required', 'a reset says why')
  return (await db.run('UPDATE lead_feedback SET reset_at = ?, reset_reason = ? WHERE id = ? AND tenant_id = ? AND reset_at IS NULL', [Math.floor(now / 1000), why, id, tenantId])).changes === 1
}

export async function listFeedback(db: Db, tenantId: string, opts: { activeOnly?: boolean; limit?: number } = {}): Promise<FeedbackRow[]> {
  const lim = opts.limit === undefined ? null : Math.max(1, Math.min(1000, Math.floor(opts.limit)))
  return (await db.all<FeedbackRow>(`SELECT ${COLS} FROM lead_feedback WHERE tenant_id = ?${opts.activeOnly ? ' AND reset_at IS NULL' : ''} ORDER BY version DESC${lim ? ' LIMIT ?' : ''}`, lim ? [tenantId, lim] : [tenantId])).map(num)
}
export async function feedbackVersion(db: Db, tenantId: string): Promise<number> {
  return Number((await db.get<{ v: number | string | null }>('SELECT MAX(version) AS v FROM lead_feedback WHERE tenant_id = ?', [tenantId]))?.v ?? 0)
}

// --- enforcing rejections in a run ---------------------------------------------------------------------------------

export interface Rejections { account: FeedbackRow[]; person: FeedbackRow[]; event: FeedbackRow[] }
export const NO_REJECTIONS: Rejections = { account: [], person: [], event: [] }
const missingTable = (e: unknown) => { const m = e instanceof Error ? e.message : String(e); return /no such table: lead_feedback|relation "lead_feedback" does not exist/i.test(m) }
// EVERY active rejection of the tenant (no row cap: the 5001st rejection is enforced like the first). A missing table
// (older deploy) is no feedback; any other failure throws FeedbackUnreadable.
export async function readRejections(db: Db, tenantId: string): Promise<Rejections> {
  let rows: FeedbackRow[]
  try { rows = (await db.all<FeedbackRow>(`SELECT ${COLS} FROM lead_feedback WHERE tenant_id = ? AND verdict = 'reject' AND reset_at IS NULL ORDER BY version`, [tenantId])).map(num) }
  catch (e) { if (missingTable(e)) return NO_REJECTIONS; throw new FeedbackUnreadable(e instanceof Error ? e.message : 'feedback store unreadable') }
  return { account: rows.filter(r => r.level === 'account'), person: rows.filter(r => r.level === 'person'), event: rows.filter(r => r.level === 'event') }
}

export interface AccountRef { company: string; company_domain?: string | null }
// Both sides name a domain: the domain decides. Otherwise the company key (case and legal suffixes aside).
export function sameAccount(r: Pick<FeedbackRow, 'company_key' | 'domain'>, c: AccountRef): boolean {
  const cd = normDomain(c.company_domain)
  if (r.domain && cd) return r.domain === cd
  const ck = companyKey(c.company)
  return ck.length >= 2 && ck === r.company_key
}
export function personMatches(r: Pick<FeedbackRow, 'person_name' | 'person_contact'>, p: { name?: string | null; contact?: string | null }): boolean {
  const n = normName(p.name), c = normContact(p.contact)
  return (!!r.person_name && (r.person_name === n || r.person_name === c)) || (!!r.person_contact && (r.person_contact === c || r.person_contact === n))
}
// The account or event rejection that holds this candidate, if any. A timing rejection holds the same day, an older day
// and an undated or unparseable one (a mirror on another URL is the same day); a strictly later day passes.
export function heldBy(rj: Rejections, c: AccountRef & { event_date?: string | null }): FeedbackRow | null {
  const acct = rj.account.find(r => sameAccount(r, c))
  if (acct) return acct
  const day = c.event_date && DAY.test(c.event_date) ? c.event_date : null
  return rj.event.find(r => sameAccount(r, c) && (!day || day <= r.event_date!)) ?? null
}
export function rejectedPerson(rj: Rejections, c: AccountRef & { name?: string | null; contact?: string | null }): FeedbackRow | null {
  return rj.person.find(r => sameAccount(r, c) && personMatches(r, c)) ?? null
}

type Cand = { company: string; company_domain?: string | null; name: string; contact: string | null; event_date?: string | null; source_url: string }
export interface FeedbackDrop<C> { cand: C; feedback_id: string; reason: RejectReason; level: Level }
// Drops what the tenant rejected and strips a rejected person (name and contact; the company stays).
// knownDomain: the company's domain when the run already knows it (a CSV company job) and the candidate does not say.
export function applyRejections<C extends Cand>(cands: C[], rj: Rejections, knownDomain: string | null = null): { kept: C[]; dropped: FeedbackDrop<C>[]; stripped: FeedbackDrop<C>[] } {
  const kept: C[] = [], dropped: FeedbackDrop<C>[] = [], stripped: FeedbackDrop<C>[] = []
  for (const c of cands) {
    const ref = { company: c.company, company_domain: c.company_domain ?? knownDomain, event_date: c.event_date, name: c.name, contact: c.contact }
    const h = heldBy(rj, ref)
    if (h) { dropped.push({ cand: c, feedback_id: h.id, reason: h.reason!, level: h.level }); continue }
    const p = rejectedPerson(rj, ref)
    if (p) { stripped.push({ cand: c, feedback_id: p.id, reason: 'wrong_person', level: 'person' }); kept.push({ ...c, name: '', contact: null }); continue }
    kept.push(c)
  }
  return { kept, dropped, stripped }
}

// After enrichment has added people and contacts to this run's leads: strip a rejected person again (the lead's own
// name/contact and the person / email rows enrichment stored). Returns how many rows changed.
export async function stripRejectedPeople(db: Db, tenantId: string, jobId: string, rj: Rejections): Promise<number> {
  if (rj.person.length === 0) return 0
  let n = 0
  const leads = await db.all<{ id: string; company: string; company_domain: string | null; name: string; contact: string | null }>('SELECT l.id, l.company, l.company_domain, l.name, l.contact FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.scan_job_id = ? AND j.user_id = ?', [jobId, tenantId])
  for (const l of leads) {
    const rows = rj.person.filter(r => sameAccount(r, l))
    if (rows.length === 0) continue
    if (rows.some(r => personMatches(r, l))) { await db.run("UPDATE leads SET name = '', contact = NULL WHERE id = ?", [l.id]); n++ }
    const enr = await db.all<{ id: string; kind: string; value: string }>("SELECT id, kind, value FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND kind IN ('person', 'email')", [l.id, tenantId])
    for (const e of enr) {
      const who = e.kind === 'person' ? { name: e.value.split(',')[0] } : { contact: e.value }
      if (rows.some(r => personMatches(r, who))) { await db.run('DELETE FROM lead_enrichments WHERE id = ? AND tenant_id = ?', [e.id, tenantId]); n++ }
    }
  }
  return n
}

export async function explainAccount(db: Db, tenantId: string, a: AccountRef): Promise<FeedbackRow[]> {
  return (await listFeedback(db, tenantId)).filter(r => sameAccount(r, a))
}

// --- learned preferences: ordering and proposals, never a drop or a gate --------------------------------------------

export const MIN_OUTCOMES = 3
export interface SourceYield { host: string; signal_kind: string | null; accepted: number; rejected: number; by_reason: Partial<Record<RejectReason, number>> }
// Explicit verdicts per source host and signal kind (calibration stays separate per signal type). Passive signals are
// never verdicts, so they are not here.
export function sourceYield(rows: FeedbackRow[]): SourceYield[] {
  const out = new Map<string, SourceYield>()
  for (const r of rows) {
    if (r.reset_at !== null || !r.source_host) continue
    const k = `${r.source_host}|${r.signal_kind ?? ''}`
    const s = out.get(k) ?? { host: r.source_host, signal_kind: r.signal_kind, accepted: 0, rejected: 0, by_reason: {} }
    if (r.verdict === 'accept') s.accepted++; else { s.rejected++; s.by_reason[r.reason!] = (s.by_reason[r.reason!] ?? 0) + 1 }
    out.set(k, s)
  }
  return [...out.values()].sort((a, b) => a.host.localeCompare(b.host) || (a.signal_kind ?? '').localeCompare(b.signal_kind ?? ''))
}
export interface Learned { delta: -1 | 0 | 1; why: string }
// A bounded ordering preference for a lead from the tenant's verdicts on the same source and signal kind. Needs
// MIN_OUTCOMES verdicts; a filter on the tenant's own past choices, not a prediction of buying.
export function learnedPreference(yields: SourceYield[], lead: { source_url: string; signal_kind?: string | null }): Learned {
  const host = hostOf(lead.source_url)
  const y = yields.find(x => x.host === host && (x.signal_kind ?? null) === (lead.signal_kind ?? null))
  if (!y || y.accepted + y.rejected < MIN_OUTCOMES) return { delta: 0, why: 'not enough of your verdicts on this source yet' }
  const n = y.accepted + y.rejected, rate = y.accepted / n
  if (rate >= 0.6) return { delta: 1, why: `you accepted ${y.accepted} of ${n} leads from ${y.host}` }
  if (rate <= 0.2) return { delta: -1, why: `you rejected ${y.rejected} of ${n} leads from ${y.host}` }
  return { delta: 0, why: `mixed verdicts on ${y.host}` }
}

export interface ProfileProposal { base_memory_version: number; base_exclusions: string[]; feedback_version: number; add_exclusions: string[]; why: string[] }
// Competitor and existing-relationship rejections proposed as named memory exclusions (the domain when known). Computed
// against the memory and feedback versions it saw; nothing changes until applyProposal.
export async function proposeProfile(db: Db, tenantId: string): Promise<ProfileProposal> {
  const mem = await readMemory(db, tenantId)
  const have = new Set((mem?.exclusions ?? []).map(x => x.toLowerCase()))
  const add: string[] = [], why: string[] = []
  const rj = await readRejections(db, tenantId)
  for (const r of rj.account) {
    if (r.reason !== 'competitor' && r.reason !== 'existing_relationship') continue
    const name = r.domain ?? (r.lead_id ? (await db.get<{ company: string }>('SELECT l.company FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?', [r.lead_id, tenantId]))?.company : null) ?? r.company_key
    if (have.has(name.toLowerCase()) || add.some(a => a.toLowerCase() === name.toLowerCase())) continue
    add.push(name); why.push(`${name}: rejected as ${r.reason.replace(/_/g, ' ')} (feedback ${r.id}, version ${r.version})`)
  }
  const order = add.map((_, i) => i).sort((i, j) => add[i].localeCompare(add[j]))
  return { base_memory_version: mem?.updated_at ?? 0, base_exclusions: mem?.exclusions ?? [], feedback_version: await feedbackVersion(db, tenantId), add_exclusions: order.map(i => add[i]), why: order.map(i => why[i]) }
}
export async function applyProposal(db: Db, tenantId: string, p: ProfileProposal): Promise<Memory> {
  const mem = await readMemory(db, tenantId)
  const stale = (mem?.updated_at ?? 0) !== p.base_memory_version || JSON.stringify(mem?.exclusions ?? []) !== JSON.stringify(p.base_exclusions) || (await feedbackVersion(db, tenantId)) !== p.feedback_version
  if (stale) throw new FeedbackError('stale_proposal', 'memory or feedback changed since this proposal was made: propose again')
  const fresh = await proposeProfile(db, tenantId)
  if (JSON.stringify(fresh.add_exclusions) !== JSON.stringify(p.add_exclusions)) throw new FeedbackError('stale_proposal', 'this proposal no longer matches your feedback: propose again')
  return writeMemory(db, tenantId, { icp: mem?.icp ?? '', positioning: mem?.positioning ?? '', tone: mem?.tone ?? '', objections: mem?.objections ?? [], exclusions: [...(mem?.exclusions ?? []), ...p.add_exclusions] })
}
