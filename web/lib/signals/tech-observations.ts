// Technographics as a discovery filter and a change signal (#389). A technology observation is a dated, scoped fact: which signature matched on which page (URL, page kind,
// detector version, fetch status), with confidence. Absence of a signature is NOT proof of non-use: it is only recorded when the page was fetched in full and is not an
// empty / blocked / JS-only shell, and it is "absent_in_scope", never "does not use". Adoption / removal is claimed only from COMPARABLE observations (same domain, same page,
// same detector version, both fully fetched) and a removal needs a second confirming absence, so an outage, a blocked page or one bad fetch cannot imply a migration.
// Technology fit is a separate label from a buying reason; it never makes a lead ready on its own. Db layer (SQLite + Postgres).
import type Database from 'better-sqlite3'
import type { Db } from '../db/client.ts'
import { detectTech, TECH_DETECTOR_VERSION } from '../connectors/techstack.ts'

export function migrateTechObservations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS tech_observations (
    tenant_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    tech TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('present','absent_in_scope')),
    page_url TEXT NOT NULL,
    page_kind TEXT NOT NULL,
    detector_version INTEGER NOT NULL,
    confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
    matched TEXT,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, domain, tech, page_url, observed_at)
  );
  CREATE INDEX IF NOT EXISTS tech_obs_domain ON tech_observations (tenant_id, domain, tech, observed_at);`)
}

export type PageKind = 'home' | 'other'
export interface Fetched { url: string; status: number | null; html: string | null; blocked?: boolean }
export interface Observation { domain: string; tech: string; state: 'present' | 'absent_in_scope'; page_url: string; page_kind: PageKind; detector_version: number; confidence: number; matched: string | null; observed_at: number }
export type Observable = { ok: true } | { ok: false; why: 'fetch_failed' | 'blocked' | 'empty' | 'js_shell' | 'not_html' }

const textLen = (html: string) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length
// Could we say anything about ABSENCE from this fetch? A failed, blocked, tiny or script-only page says nothing.
export function observable(f: Fetched): Observable {
  if (f.blocked) return { ok: false, why: 'blocked' }
  if (f.status === null || f.status < 200 || f.status >= 300 || f.html === null) return { ok: false, why: 'fetch_failed' }
  if (!/<html|<body|<head/i.test(f.html)) return { ok: false, why: 'not_html' }
  if (f.html.length < 500) return { ok: false, why: 'empty' }
  if (textLen(f.html) < 80 && /<div id=["'](?:root|app|__next)["']/i.test(f.html)) return { ok: false, why: 'js_shell' }
  return { ok: true }
}
const host = (d: string) => d.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0]
const pageKind = (u: string): PageKind => { try { const p = new URL(u).pathname; return p === '/' || p === '' ? 'home' : 'other' } catch { return 'other' } }

// Observations from one fetched page against a set of technologies of interest (the filter's technologies plus whatever was detected). 'present' needs a signature match;
// 'absent_in_scope' only for a technology the caller is tracking, and only when the page was observable.
export function observe(domain: string, f: Fetched, tracked: string[], now: number): { observations: Observation[]; unobservable?: Observable & { ok: false } } {
  const o = observable(f)
  if (!o.ok) return { observations: [], unobservable: o }
  const hits = detectTech(f.html!), seen = new Map(hits.map(h => [h.name.toLowerCase(), h]))
  const base = { domain: host(domain), page_url: f.url, page_kind: pageKind(f.url), detector_version: TECH_DETECTOR_VERSION, observed_at: now }
  const out: Observation[] = hits.map(h => ({ ...base, tech: h.name, state: 'present' as const, confidence: 85, matched: h.where }))
  for (const t of tracked) if (!seen.has(t.toLowerCase())) out.push({ ...base, tech: t, state: 'absent_in_scope', confidence: 55, matched: null })
  return { observations: out }
}

export type Change = { kind: 'adopted' | 'removed'; tech: string; from: Observation; to: Observation } | { kind: 'none' | 'unconfirmed' | 'not_comparable'; why: string }
const comparable = (a: Observation, b: Observation) => a.domain === b.domain && a.tech === b.tech && a.page_kind === b.page_kind && new URL(a.page_url).pathname === new URL(b.page_url).pathname && a.detector_version === b.detector_version
// history: observations of ONE technology on ONE domain, any order. Adoption: an absent then present on comparable pages. Removal: present, then TWO consecutive comparable
// absences (a single missing signature may be a bad fetch or a changed template). Dated evidence for both ends is returned.
export function changeFor(history: Observation[]): Change {
  const h = [...history].sort((a, b) => a.observed_at - b.observed_at)
  if (h.length < 2) return { kind: 'none', why: 'fewer than two observations' }
  const last = h[h.length - 1], prev = h[h.length - 2]
  if (!comparable(prev, last)) return { kind: 'not_comparable', why: 'observations are on a different page, kind or detector version' }
  if (prev.state === 'absent_in_scope' && last.state === 'present') return { kind: 'adopted', tech: last.tech, from: prev, to: last }
  if (prev.state === 'absent_in_scope' && last.state === 'absent_in_scope') {
    const lastPresent = [...h].reverse().find(o => o.state === 'present' && comparable(o, last))
    if (lastPresent) return { kind: 'removed', tech: last.tech, from: lastPresent, to: last }
  }
  if (prev.state === 'present' && last.state === 'absent_in_scope') return { kind: 'unconfirmed', why: 'one absence is not a removal: needs a second comparable observation' }
  return { kind: 'none', why: 'no change' }
}

export interface TechFilter { uses?: string[]; notUses?: string[]; migratedFrom?: string; migratedTo?: string }
export type Tri = 'yes' | 'no' | 'unknown'
export interface Snapshot { latest: Map<string, Observation>; changes: Map<string, Change> }
export function snapshotOf(obs: Observation[]): Snapshot {
  const by = new Map<string, Observation[]>(); for (const o of obs) by.set(o.tech.toLowerCase(), [...(by.get(o.tech.toLowerCase()) ?? []), o])
  const latest = new Map<string, Observation>(), changes = new Map<string, Change>()
  for (const [k, list] of by) { latest.set(k, [...list].sort((a, b) => b.observed_at - a.observed_at)[0]); changes.set(k, changeFor(list)) }
  return { latest, changes }
}
// Three-valued: 'unknown' never satisfies a filter. notUses needs an OBSERVED absence (unobserved is not non-use), and says "absent in scope", not proof.
export function matchesFilter(s: Snapshot, f: TechFilter): { match: Tri; reasons: string[]; unknown: string[] } {
  const reasons: string[] = [], unknown: string[] = []; let all: Tri = 'yes'
  const need = (cond: Tri, why: string, name: string) => { if (cond === 'yes') reasons.push(why); else { if (cond === 'unknown') unknown.push(name); all = all === 'no' || cond === 'no' ? 'no' : 'unknown' } }
  for (const t of f.uses ?? []) { const o = s.latest.get(t.toLowerCase()); need(!o ? 'unknown' : o.state === 'present' ? 'yes' : 'no', `${t} seen on ${o?.page_url} (${new Date((o?.observed_at ?? 0) * 1000).toISOString().slice(0, 10)})`, t) }
  for (const t of f.notUses ?? []) { const o = s.latest.get(t.toLowerCase()); need(!o ? 'unknown' : o.state === 'absent_in_scope' ? 'yes' : 'no', `${t} not found on ${o?.page_url} (absent in that page, not proof of non-use)`, t) }
  if (f.migratedFrom) { const c = s.changes.get(f.migratedFrom.toLowerCase()); need(c && c.kind === 'removed' ? 'yes' : !c || c.kind === 'unconfirmed' || c.kind === 'not_comparable' || (c.kind === 'none' && /fewer than two/.test(c.why)) ? 'unknown' : 'no', `${f.migratedFrom} removal confirmed by two comparable dated observations`, f.migratedFrom) }
  if (f.migratedTo) { const c = s.changes.get(f.migratedTo.toLowerCase()); need(c && c.kind === 'adopted' ? 'yes' : !c || c.kind === 'not_comparable' || (c.kind === 'none' && /fewer than two/.test(c.why)) ? 'unknown' : 'no', `${f.migratedTo} adoption seen on comparable dated observations`, f.migratedTo) }
  return { match: all, reasons, unknown }
}

// Net-new discovery queries from an explicit technology filter (to feed the normal verifier, never to skip it).
export function techQueries(f: TechFilter, where: string[] = []): string[] {
  const loc = where[0] ?? '', qs: string[] = []
  for (const t of f.uses ?? []) qs.push(`companies using ${t} ${loc}`.trim(), `"powered by ${t}" ${loc}`.trim())
  if (f.migratedFrom && f.migratedTo) qs.push(`migrated from ${f.migratedFrom} to ${f.migratedTo}`, `switched from ${f.migratedFrom} to ${f.migratedTo} ${loc}`.trim())
  else if (f.migratedFrom) qs.push(`replacing ${f.migratedFrom} ${loc}`.trim(), `moving off ${f.migratedFrom} ${loc}`.trim())
  return [...new Set(qs)].slice(0, 6)
}
// Technology fit is its own label. A buying reason (a verified, dated event) is separate; with fit alone the lead is not ready.
export function techLabel(m: { match: Tri }, buyingReason: { date: string; source_url: string } | null): { fit: Tri; readiness: 'tech_fit_only' | 'tech_fit_with_reason' | 'not_a_fit'; label: string } {
  if (m.match !== 'yes') return { fit: m.match, readiness: 'not_a_fit', label: m.match === 'unknown' ? 'Technology fit unknown - not enough comparable observations' : 'Does not match the technology filter' }
  return buyingReason ? { fit: 'yes', readiness: 'tech_fit_with_reason', label: 'Technology fit + a separate dated buying reason' } : { fit: 'yes', readiness: 'tech_fit_only', label: 'Technology fit only - no buying reason yet' }
}

export async function recordObservations(db: Db, tenantId: string, obs: Observation[]): Promise<void> {
  for (const o of obs) await db.run('INSERT INTO tech_observations (tenant_id, domain, tech, state, page_url, page_kind, detector_version, confidence, matched, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [tenantId, o.domain, o.tech, o.state, o.page_url.slice(0, 500), o.page_kind, o.detector_version, o.confidence, o.matched, o.observed_at])
}
export async function loadObservations(db: Db, tenantId: string, domain: string): Promise<Observation[]> {
  return (await db.all<Observation>('SELECT domain, tech, state, page_url, page_kind, detector_version, confidence, matched, observed_at FROM tech_observations WHERE tenant_id = ? AND domain = ? ORDER BY observed_at', [tenantId, host(domain)])).map(r => ({ ...r, detector_version: Number(r.detector_version), confidence: Number(r.confidence), observed_at: Number(r.observed_at) }))
}
