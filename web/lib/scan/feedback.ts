// Structured, reasoned accept/reject feedback (#385). A rejection is recorded at the canonical account / person / event level with WHY (wrong industry, person,
// location, timing; competitor; existing relationship; not useful). Hard rules (the user's exclusions, the verifier gates) are separate and are never touched here:
// feedback is a learned layer on top - it filters and ranks, it is explainable (every decision names the feedback row and reason), reversible (revert keeps the
// row), versioned (each change bumps the tenant's feedback version) and tenant-scoped. Passive opt-outs / unsubscribes never count as a positive cohort.
// Entities, CRM state and relationships belong to #364/#365; this keeps only the keys it needs and does not duplicate that implementation.
import type Database from 'better-sqlite3'
import type { Db } from '../db/client.ts'

export type EntityKind = 'account' | 'person' | 'event'
export type Reason = 'wrong_industry' | 'wrong_person' | 'wrong_location' | 'wrong_timing' | 'competitor' | 'existing_relationship' | 'not_useful'
export type Polarity = 'reject' | 'accept'
export type Origin = 'explicit' | 'passive_optout' | 'reply_positive'   // passive_optout: an unsubscribe / bounce / silence - never a positive signal
export const REASONS: readonly Reason[] = ['wrong_industry', 'wrong_person', 'wrong_location', 'wrong_timing', 'competitor', 'existing_relationship', 'not_useful']
// Timing is the only reason a NEW relevant event may lift. Everything else holds until an explicit reset.

export function migrateFeedback(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS lead_feedback (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    entity_kind TEXT NOT NULL CHECK (entity_kind IN ('account','person','event')),
    entity_key TEXT NOT NULL,
    account_key TEXT NOT NULL,
    polarity TEXT NOT NULL CHECK (polarity IN ('reject','accept')),
    reason TEXT,
    origin TEXT NOT NULL DEFAULT 'explicit' CHECK (origin IN ('explicit','passive_optout','reply_positive')),
    source TEXT,
    query_key TEXT,
    event_key TEXT,
    note TEXT,
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    reverted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_lead_feedback_tenant ON lead_feedback (tenant_id, entity_kind, entity_key);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_feedback_version ON lead_feedback (tenant_id, version);`)
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\b(?:inc|llc|ltd|corp|co|company|the|gmbh)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
const host = (d: string) => d.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0]
// The same account is the same key however it is spelled: a domain wins, else the normalised company name.
export const accountKey = (l: { company: string; company_domain?: string | null }) => (l.company_domain && host(l.company_domain).includes('.') ? `d:${host(l.company_domain)}` : `n:${slug(l.company)}`)
export const personKey = (l: { company: string; company_domain?: string | null }, name: string) => `${accountKey(l)}|p:${slug(name)}`
export const eventKey = (l: { company: string; company_domain?: string | null }, event: { date?: string | null; source_url?: string | null; kind?: string | null }) => `${accountKey(l)}|e:${[event.kind ?? '', event.date ?? '', (event.source_url ?? '').replace(/^[a-z]+:\/\/(www\.)?/i, '').replace(/[?#].*$/, '')].join('~').toLowerCase()}`

export interface FeedbackRow { id: string; entity_kind: EntityKind; entity_key: string; account_key: string; polarity: Polarity; reason: Reason | null; origin: Origin; source: string | null; query_key: string | null; event_key: string | null; note: string | null; version: number; created_at: number; reverted_at: number | null }
export interface FeedbackInput { entity_kind: EntityKind; entity_key: string; account_key: string; polarity: Polarity; reason?: Reason | null; origin?: Origin; source?: string | null; query_key?: string | null; event_key?: string | null; note?: string | null }
export class FeedbackError extends Error {}
export class FeedbackUnreadable extends Error {}

export async function currentVersion(db: Db, tenantId: string): Promise<number> {
  const r = await db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM lead_feedback WHERE tenant_id = ?', [tenantId]); return Number(r?.v ?? 0)
}
export async function recordFeedback(db: Db, tenantId: string, f: FeedbackInput, now = Math.floor(Date.now() / 1000)): Promise<FeedbackRow> {
  const origin = f.origin ?? 'explicit'
  if (f.polarity === 'reject' && !(f.reason && REASONS.includes(f.reason))) throw new FeedbackError('a rejection needs one of the listed reasons')
  if (f.polarity === 'accept' && origin === 'passive_optout') throw new FeedbackError('a passive opt-out is never a positive signal')
  if (f.polarity === 'reject' && ((f.reason === 'wrong_timing') !== (f.entity_kind === 'event') || (f.reason === 'wrong_person') !== (f.entity_kind === 'person'))) throw new FeedbackError('the reason decides the level: wrong_timing -> event, wrong_person -> person, the rest -> account')
  if (f.polarity === 'accept' && f.reason) throw new FeedbackError('an accept carries no rejection reason')
  // The version is MAX+1 and (tenant_id, version) is unique: two concurrent rejections can compute the same number, the loser's insert is refused and retried with the next one.
  for (let attempt = 0; ; attempt++) {
    const id = `fb_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const version = (await currentVersion(db, tenantId)) + 1
    try { return await insertFeedback(db, tenantId, f, origin, id, version, now) } catch (e) { if (attempt >= 12 || !/unique|duplicate|constraint/i.test((e as Error).message)) throw e }
  }
}
async function insertFeedback(db: Db, tenantId: string, f: FeedbackInput, origin: Origin, id: string, version: number, now: number): Promise<FeedbackRow> {
  await db.run('INSERT INTO lead_feedback (id, tenant_id, entity_kind, entity_key, account_key, polarity, reason, origin, source, query_key, event_key, note, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, tenantId, f.entity_kind, f.entity_key, f.account_key, f.polarity, f.reason ?? null, origin, f.source ?? null, f.query_key ?? null, f.event_key ?? null, (f.note ?? '').slice(0, 300) || null, version, now])
  return { id, entity_kind: f.entity_kind, entity_key: f.entity_key, account_key: f.account_key, polarity: f.polarity, reason: f.reason ?? null, origin, source: f.source ?? null, query_key: f.query_key ?? null, event_key: f.event_key ?? null, note: f.note ?? null, version, created_at: now, reverted_at: null }
}
// Reversible: the row is kept (it explains history) and stops counting. Only the owning tenant can revert it.
export async function revertFeedback(db: Db, tenantId: string, id: string, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const r = await db.run('UPDATE lead_feedback SET reverted_at = ? WHERE id = ? AND tenant_id = ? AND reverted_at IS NULL', [now, id, tenantId]); return r.changes > 0
}
const COLS = 'id, entity_kind, entity_key, account_key, polarity, reason, origin, source, query_key, event_key, note, version, created_at, reverted_at'
export async function activeFeedback(db: Db, tenantId: string): Promise<FeedbackRow[]> {
  return (await db.all<FeedbackRow>(`SELECT ${COLS} FROM lead_feedback WHERE tenant_id = ? AND reverted_at IS NULL ORDER BY version`, [tenantId])).map(r => ({ ...r, version: Number(r.version), created_at: Number(r.created_at) }))
}
// Same read for the scan runner, which still holds the raw SQLite handle (as it does for memory). A missing table (older deploy) means no feedback.
export function activeFeedbackSync(db: Database.Database, tenantId: string): FeedbackRow[] {
  try { return db.prepare(`SELECT ${COLS} FROM lead_feedback WHERE tenant_id = ? AND reverted_at IS NULL ORDER BY version`).all(tenantId) as FeedbackRow[] }
  catch (e) { if (/no such table/i.test((e as Error).message)) return []; throw new FeedbackUnreadable((e as Error).message) }   // a missing table is an older deploy (no feedback); any other failure is UNKNOWN, never "none" 
}

export interface Held { held: true; row: FeedbackRow; explanation: string }
// The event day a stored event key was made from ("<account>|e:<kind>~<date>~<url>"). The URL is deliberately NOT part of event identity (a mirror/syndicated copy of the same story is the same event).
export const eventDateOf = (key: string | null | undefined): string | null => { const m = /\|e:[^~]*~(\d{4}-\d{2}-\d{2})~/.exec(key ?? ''); return m ? m[1] : null }
const EVENT_DAY = /^\d{4}-\d{2}-\d{2}$/
// Is this lead held by an active ACCOUNT or EVENT rejection? An account rejection holds until reverted. A timing rejection holds the rejected event, any OLDER event, any mirror of either (same day, different URL) and anything
// undated; only an event with a STRICTLY LATER day is a new relevant event and passes. Person rejections are not a hold on the lead (see rejectedPeople: the person is stripped, the company stays). Reset = revert.
export function heldBy(rows: FeedbackRow[], lead: { company: string; company_domain?: string | null }, ctx: { event?: { date?: string | null; source_url?: string | null; kind?: string | null } | null } = {}): Held | null {
  const acct = accountKey(lead), day = ctx.event?.date && EVENT_DAY.test(ctx.event.date) ? ctx.event.date : null
  for (const r of rows) {
    if (r.polarity !== 'reject') continue
    if (r.entity_kind === 'account' && r.entity_key === acct) return { held: true, row: r, explanation: `rejected (${r.reason}) at account level on version ${r.version}${r.note ? `: ${r.note}` : ''}; revert the feedback to reset` }
    if (r.entity_kind === 'event' && r.account_key === acct) {
      const rejectedDay = eventDateOf(r.event_key) ?? eventDateOf(r.entity_key)
      if (day && rejectedDay && day > rejectedDay) continue   // a strictly later, newly surfaced event day
      return { held: true, row: r, explanation: `rejected (${r.reason}) at event level on version ${r.version}${rejectedDay ? ` (event ${rejectedDay})` : ''}${r.note ? `: ${r.note}` : ''}; only a later event day lifts it, or revert the feedback` }
    }
  }
  return null
}
// Person-level rejections for this lead: the names/addresses the lead carries that the user said were the wrong person. The caller strips them; the company is not held.
export function rejectedPeople(rows: FeedbackRow[], lead: { company: string; company_domain?: string | null }, people: (string | null | undefined)[]): FeedbackRow[] {
  const keys = new Set(people.filter((p): p is string => !!p && !!p.trim()).map(p => personKey(lead, p)))
  return rows.filter(r => r.polarity === 'reject' && r.entity_kind === 'person' && keys.has(r.entity_key))
}
export function filterRejected<T extends { company: string; company_domain?: string | null }>(rows: FeedbackRow[], leads: T[], ctxOf: (l: T) => Parameters<typeof heldBy>[2] = () => ({})): { kept: T[]; held: { lead: T; why: string }[] } {
  const kept: T[] = [], held: { lead: T; why: string }[] = []
  for (const l of leads) { const h = heldBy(rows, l, ctxOf(l)); if (h) held.push({ lead: l, why: h.explanation }); else kept.push(l) }
  return { kept, held }
}

export interface SourceYield { source: string; query_key: string | null; accepts: number; rejects: number; rate: number | null; n: number }
// Learned source/query yield from ACTUAL outcomes. Only explicit accepts and positive replies count as positive; passive opt-outs are excluded from both sides
// (they say nothing about fit); too few outcomes give no rate (null), never a guess.
export const MIN_OUTCOMES = 3
export function sourceYield(rows: FeedbackRow[]): SourceYield[] {
  const m = new Map<string, SourceYield>()
  for (const r of rows) {
    if (!r.source || r.origin === 'passive_optout') continue
    const k = `${r.source}|${r.query_key ?? ''}`; const y = m.get(k) ?? { source: r.source, query_key: r.query_key, accepts: 0, rejects: 0, rate: null, n: 0 }
    if (r.polarity === 'accept') y.accepts++; else y.rejects++
    m.set(k, y)
  }
  return [...m.values()].map(y => ({ ...y, n: y.accepts + y.rejects, rate: y.accepts + y.rejects >= MIN_OUTCOMES ? y.accepts / (y.accepts + y.rejects) : null })).sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.n - a.n)
}
// Ranking nudge for a lead's source: bounded (+/-1), only with enough outcomes, never overriding a gate. 0 when unknown.
export function rankAdjustment(yields: SourceYield[], source: string | null | undefined, query_key?: string | null): { delta: -1 | 0 | 1; why: string } {
  const y = yields.find(x => x.source === source && x.query_key === (query_key ?? null)) ?? yields.find(x => x.source === source && x.query_key === null)
  if (!y || y.rate === null) return { delta: 0, why: 'not enough outcomes to learn from' }
  return y.rate >= 0.6 ? { delta: 1, why: `${y.accepts}/${y.n} accepted from this source` } : y.rate <= 0.2 ? { delta: -1, why: `${y.rejects}/${y.n} rejected from this source` } : { delta: 0, why: 'mixed outcomes' }
}

export interface ProfileProposal { version: number; kind: 'add_exclusion' | 'tighten_location' | 'revisit_persona' | 'drop_source'; text: string; evidence: string[] }
// Proposed (never applied) profile improvements from repeated explicit reasons. The user versions and applies them; hard exclusions stay theirs.
export function proposeProfileImprovements(rows: FeedbackRow[], version: number, min = 3): ProfileProposal[] {
  const ex = rows.filter(r => r.polarity === 'reject' && r.origin === 'explicit'), out: ProfileProposal[] = []
  const by = (reason: Reason) => ex.filter(r => r.reason === reason)
  const comp = by('competitor'); if (comp.length >= min) out.push({ version, kind: 'add_exclusion', text: 'Exclude competitors: ' + [...new Set(comp.map(r => r.account_key))].slice(0, 5).join(', '), evidence: comp.map(r => r.id) })
  const loc = by('wrong_location'); if (loc.length >= min) out.push({ version, kind: 'tighten_location', text: `${loc.length} rejections for wrong location: tighten the geography`, evidence: loc.map(r => r.id) })
  const per = by('wrong_person'); if (per.length >= min) out.push({ version, kind: 'revisit_persona', text: `${per.length} rejections for the wrong person: revisit the buyer persona`, evidence: per.map(r => r.id) })
  for (const y of sourceYield(rows)) if (y.rate !== null && y.rate === 0) out.push({ version, kind: 'drop_source', text: `${y.source} produced ${y.n} rejections and no accepts`, evidence: ex.filter(r => r.source === y.source).map(r => r.id) })
  return out
}

// Applies the tenant's learned rejections to a verification outcome (the runner calls this once, after the hard exclusions): account / event rejections drop the candidate ('rejected_feedback'), a rejected person is
// stripped from the lead, and an UNREADABLE store holds every candidate ('feedback_unreadable') instead of reading as "no feedback".
type Cand = { company: string; company_domain?: string | null; name: string; contact: string | null; event_date?: string | null; source_url: string }
export function applyFeedback<L extends Cand, R extends Cand>(db: Database.Database, tenantId: string, outcome: { leads: L[]; review: R[]; dropped: Record<string, number> }, markDropped: (rows: Cand[], reason: string) => void = () => {}): void {
  let fb: FeedbackRow[] | null
  try { fb = activeFeedbackSync(db, tenantId) } catch { fb = null }
  if (fb === null) {
    const all = [...outcome.leads, ...outcome.review]
    if (all.length > 0) { outcome.dropped['feedback_unreadable'] = (outcome.dropped['feedback_unreadable'] ?? 0) + all.length; markDropped(all, 'feedback_unreadable'); outcome.leads = []; outcome.review = [] }
    return
  }
  if (fb.length === 0) return
  const rows = fb, ev = (l: Cand) => ({ event: { date: l.event_date, source_url: l.source_url } })
  const a = filterRejected(rows, outcome.leads, ev), b = filterRejected(rows, outcome.review, ev)
  const n = outcome.leads.length - a.kept.length + outcome.review.length - b.kept.length
  if (n > 0) { outcome.dropped['rejected_feedback'] = (outcome.dropped['rejected_feedback'] ?? 0) + n; markDropped([...a.held, ...b.held].map(h => h.lead), 'rejected_feedback') }
  const strip = <T extends Cand>(xs: T[]): T[] => xs.map(l => rejectedPeople(rows, l, [l.name, l.contact]).length ? { ...l, name: '', contact: null } : l)
  outcome.leads = strip(a.kept); outcome.review = strip(b.kept)
}
