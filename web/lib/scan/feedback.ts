// Structured accept / reject feedback on leads (#385; docs/design/lead-feedback.md). A tenant's reasoned verdict on an
// account, a person or an event is stored at that level and applied to every later run, so a rejected entity is not
// brought back by the next play.
//
//  - Levels. An account rejection (wrong industry or location, a competitor, an existing relationship, not useful) drops
//    the company from later runs. A person rejection (wrong person) drops only that person and contact; the company can
//    still come with someone else. A timing rejection (wrong timing) drops only that event or an older one: a NEWER event
//    for the same company is a new reason to look and passes (the "new relevant event" policy).
//  - Explainable and reversible. A dropped candidate is recorded in the run's audit with the feedback id and reason;
//    explainEntity lists what applies to a company; resetFeedback reverses one verdict, with its reason kept.
//  - Hard rules apart from learned preferences. Rejections are explicit rules and are applied. What is learned from
//    outcomes - which sources yield accepted or rejected leads, which exclusions the rejections suggest - is reported as
//    a proposal against the memory version it was computed on; it changes nothing until the tenant applies it.
//  - Tenant-isolated. Every read and write takes the tenant.
//  - Keys. Until the canonical account graph (#364) exists, an account is matched by its company key (legal suffixes and
//    case aside) or its domain, a person by name or address. Same-name unrelated businesses are #364's to split.
import { randomBytes } from 'node:crypto'
import type { Db } from '../db/client.ts'
import { companyKey } from './evidence.ts'
import { readMemory, writeMemory, type Memory } from '../memory.ts'

export const REJECT_REASONS = ['wrong_industry', 'wrong_location', 'competitor', 'existing_relationship', 'not_useful', 'wrong_person', 'wrong_timing'] as const
export type RejectReason = typeof REJECT_REASONS[number]
export type Level = 'account' | 'person' | 'event'
export const LEVEL_OF: Record<RejectReason, Level> = { wrong_industry: 'account', wrong_location: 'account', competitor: 'account', existing_relationship: 'account', not_useful: 'account', wrong_person: 'person', wrong_timing: 'event' }
export class FeedbackError extends Error {}

export interface FeedbackRow { id: string; tenant_id: string; verdict: 'accept' | 'reject'; level: Level; reason: RejectReason | null; company_key: string; domain: string | null; person_key: string | null; event_date: string | null; source_host: string | null; lead_id: string | null; job_id: string | null; note: string | null; created_at: number; reset_at: number | null; reset_reason: string | null }
const COLS = 'id, tenant_id, verdict, level, reason, company_key, domain, person_key, event_date, source_host, lead_id, job_id, note, created_at, reset_at, reset_reason'

const host = (u: string | null | undefined) => { try { return u ? new URL(u).hostname.replace(/^www\./, '') : null } catch { return null } }
const personKey = (name: string | null | undefined, contact: string | null | undefined) => { const n = (name ?? '').trim().toLowerCase(); const c = (contact ?? '').trim().toLowerCase(); return c.includes('@') ? c : n || null }

// Records a verdict on one of the tenant's leads. The lead is read through the tenant, so another tenant's lead id is
// unknown here.
export async function recordFeedback(db: Db, tenantId: string, input: { lead_id: string; verdict: 'accept' | 'reject'; reason?: RejectReason; note?: string }, now = Date.now()): Promise<FeedbackRow> {
  if (input.verdict === 'reject' && !REJECT_REASONS.includes(input.reason as RejectReason)) throw new FeedbackError(`a rejection needs a reason: ${REJECT_REASONS.join(', ')}`)
  if (input.verdict === 'accept' && input.reason) throw new FeedbackError('an acceptance has no reject reason')
  const note = input.note?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300) || null
  const lead = await db.get<{ id: string; company: string; company_domain: string | null; name: string; contact: string | null; event_date: string | null; source_url: string; scan_job_id: string }>(
    'SELECT l.id, l.company, l.company_domain, l.name, l.contact, l.event_date, l.source_url, l.scan_job_id FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?', [input.lead_id, tenantId])
  if (!lead) throw new FeedbackError('no such lead')
  const key = companyKey(lead.company)
  if (key.length < 2) throw new FeedbackError('the lead names no company')
  const level: Level = input.verdict === 'reject' ? LEVEL_OF[input.reason!] : 'account'
  const person = personKey(lead.name, lead.contact)
  if (level === 'person' && !person) throw new FeedbackError('a wrong-person rejection needs a named person or contact on the lead')
  if (level === 'event' && !lead.event_date) throw new FeedbackError('a wrong-timing rejection needs a dated event')
  const row: FeedbackRow = {
    id: randomBytes(12).toString('hex'), tenant_id: tenantId, verdict: input.verdict, level, reason: input.reason ?? null,
    company_key: key, domain: lead.company_domain?.toLowerCase() ?? null, person_key: level === 'person' ? person : null, event_date: level === 'event' ? lead.event_date : null,
    source_host: host(lead.source_url), lead_id: lead.id, job_id: lead.scan_job_id, note, created_at: Math.floor(now / 1000), reset_at: null, reset_reason: null,
  }
  await db.run(`INSERT INTO lead_feedback (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [row.id, row.tenant_id, row.verdict, row.level, row.reason, row.company_key, row.domain, row.person_key, row.event_date, row.source_host, row.lead_id, row.job_id, row.note, row.created_at, null, null])
  return row
}

export async function resetFeedback(db: Db, tenantId: string, id: string, reason: string, now = Date.now()): Promise<boolean> {
  const why = reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200)
  if (!why) throw new FeedbackError('a reset says why')
  return (await db.run('UPDATE lead_feedback SET reset_at = ?, reset_reason = ? WHERE id = ? AND tenant_id = ? AND reset_at IS NULL', [Math.floor(now / 1000), why, id, tenantId])).changes === 1
}

export const listFeedback = (db: Db, tenantId: string, limit = 200): Promise<FeedbackRow[]> =>
  db.all<FeedbackRow>(`SELECT ${COLS} FROM lead_feedback WHERE tenant_id = ? ORDER BY created_at DESC, id LIMIT ?`, [tenantId, Math.max(1, Math.min(1000, Math.floor(limit)))])

// --- applying rejections to a run ----------------------------------------------------------------------------------

export interface Rejections { account: FeedbackRow[]; person: FeedbackRow[]; event: FeedbackRow[] }
export const NO_REJECTIONS: Rejections = { account: [], person: [], event: [] }
export async function activeRejections(db: Db, tenantId: string): Promise<Rejections> {
  const rows = await db.all<FeedbackRow>(`SELECT ${COLS} FROM lead_feedback WHERE tenant_id = ? AND verdict = 'reject' AND reset_at IS NULL ORDER BY created_at, id LIMIT 5000`, [tenantId])
  return { account: rows.filter(r => r.level === 'account'), person: rows.filter(r => r.level === 'person'), event: rows.filter(r => r.level === 'event') }
}

const sameAccount = (r: FeedbackRow, c: { company: string; domain?: string | null }) => r.company_key === companyKey(c.company) || (!!r.domain && !!c.domain && r.domain === c.domain.toLowerCase())

export interface Candidate { company: string; name: string; contact: string | null; event_date: string | null; source_url: string; company_domain?: string | null }
export interface FeedbackDrop { company: string; url: string; feedback_id: string; reason: RejectReason; level: Level }
// Drops what the tenant rejected and strips a rejected person, returning what stays and why each drop happened.
export function applyRejections<C extends Candidate>(cands: C[], rj: Rejections): { kept: C[]; dropped: FeedbackDrop[]; persons_removed: FeedbackDrop[] } {
  const kept: C[] = [], dropped: FeedbackDrop[] = [], persons: FeedbackDrop[] = []
  for (const c of cands) {
    const acct = rj.account.find(r => sameAccount(r, { company: c.company, domain: c.company_domain }))
    if (acct) { dropped.push({ company: c.company, url: c.source_url, feedback_id: acct.id, reason: acct.reason!, level: 'account' }); continue }
    // the same event, or an older one, after a timing rejection; a newer dated event passes (and an undated one cannot be told apart: it is held back too)
    const ev = rj.event.find(r => sameAccount(r, { company: c.company, domain: c.company_domain }) && (!c.event_date || c.event_date <= r.event_date!))
    if (ev) { dropped.push({ company: c.company, url: c.source_url, feedback_id: ev.id, reason: 'wrong_timing', level: 'event' }); continue }
    const pk = personKey(c.name, c.contact)
    const pr = pk ? rj.person.find(r => sameAccount(r, { company: c.company, domain: c.company_domain }) && (r.person_key === pk || r.person_key === (c.name ?? '').trim().toLowerCase() || (!!c.contact && r.person_key === c.contact.trim().toLowerCase()))) : undefined
    if (pr) { persons.push({ company: c.company, url: c.source_url, feedback_id: pr.id, reason: 'wrong_person', level: 'person' }); kept.push({ ...c, name: '', contact: null }); continue }
    kept.push(c)
  }
  return { kept, dropped, persons_removed: persons }
}

export async function explainEntity(db: Db, tenantId: string, company: string, domain?: string | null): Promise<FeedbackRow[]> {
  return (await listFeedback(db, tenantId, 1000)).filter(r => sameAccount(r, { company, domain }))
}

// --- learned preferences (reported, never applied by themselves) ---------------------------------------------------

export interface SourceYield { host: string; accepted: number; rejected: number; by_reason: Partial<Record<RejectReason, number>> }
// Which sources the tenant's verdicts favour: counts per source host. A preference to weigh, not a rule.
export async function sourceYield(db: Db, tenantId: string): Promise<SourceYield[]> {
  const out = new Map<string, SourceYield>()
  for (const r of await listFeedback(db, tenantId, 1000)) {
    if (r.reset_at !== null || !r.source_host) continue
    const s = out.get(r.source_host) ?? { host: r.source_host, accepted: 0, rejected: 0, by_reason: {} }
    if (r.verdict === 'accept') s.accepted++; else { s.rejected++; s.by_reason[r.reason!] = (s.by_reason[r.reason!] ?? 0) + 1 }
    out.set(r.source_host, s)
  }
  return [...out.values()].sort((a, b) => a.host.localeCompare(b.host))
}

export interface ProfileProposal { base_memory_version: number; add_exclusions: string[]; why: string[] }
// A proposed memory change from explicit rejections: competitors and existing relationships become named exclusions.
// Computed against the memory version it saw; applyProposal refuses it once memory changed since.
export async function proposeProfile(db: Db, tenantId: string): Promise<ProfileProposal> {
  const mem = await readMemory(db, tenantId)
  const have = new Set((mem?.exclusions ?? []).map(x => x.toLowerCase()))
  const add: string[] = [], why: string[] = []
  for (const r of (await activeRejections(db, tenantId)).account) {
    if (r.reason !== 'competitor' && r.reason !== 'existing_relationship') continue
    const name = (await db.get<{ company: string }>('SELECT l.company FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?', [r.lead_id, tenantId]))?.company ?? r.company_key
    if (have.has(name.toLowerCase()) || add.some(a => a.toLowerCase() === name.toLowerCase())) continue
    add.push(name); why.push(`${name}: rejected as ${r.reason.replace(/_/g, ' ')} (feedback ${r.id})`)
  }
  const order = add.map((a, i) => i).sort((i, j) => add[i].localeCompare(add[j]))
  return { base_memory_version: mem?.updated_at ?? 0, add_exclusions: order.map(i => add[i]), why: order.map(i => why[i]) }
}
export async function applyProposal(db: Db, tenantId: string, p: ProfileProposal): Promise<Memory> {
  const mem = await readMemory(db, tenantId)
  if ((mem?.updated_at ?? 0) !== p.base_memory_version) throw new FeedbackError('memory changed since this proposal was made: propose again')
  return writeMemory(db, tenantId, { icp: mem?.icp ?? '', positioning: mem?.positioning ?? '', tone: mem?.tone ?? '', objections: mem?.objections ?? [], exclusions: [...(mem?.exclusions ?? []), ...p.add_exclusions] })
}
