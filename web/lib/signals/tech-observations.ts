// #389: technographics as a discovery filter and a dated change signal, built only on what the site crawl already downloads
// (lib/connectors/techstack.ts; no new provider, no extra fetch). Pure: no db, no network (targeting-proof.ts and the runner use it).
//
// A technology observation is a dated, scoped fact: which signatures matched on which page of which domain, at what time, with which
// detector version, and whether that page could say anything about ABSENCE at all (techstack.ts observability()). It is stored as one
// `tech_scan` row per crawl in lead_enrichments (no schema change): value `<domain>|<unix seconds>`, label `tech-scan-v1|<detector
// version>|<path>|<observability>|<keys>`.
//
// Rules this module keeps:
//   - A signature found is presence. A signature NOT found is never "does not use": only "not seen on that page".
//   - Change is claimed only between COMPARABLE observations: same domain, same page path, same detector version, every one of them a
//     fully readable page. A blocked, failed, thin (JS shell / consent wall / maintenance) page is not compared at all, so an outage
//     or an inaccessible page can never imply a migration.
//   - Adoption: readable pages without the signature, then a readable page with it, and no earlier comparable page ever showing it.
//   - Removal: a readable page with the signature, then TWO consecutive readable pages without it (one missing script can be a
//     template variant or a bad deploy). Both ends are dated and carry the page URL.
import { TECH_DETECTOR_VERSION, techKey, techFromKey, type Observability } from '../connectors/techstack.ts'

export const TECH_SCAN_KIND = 'tech_scan'
export const TECH_CHANGE_KIND = 'tech_change'
export const TECH_SCOPE = 'homepage HTML only (static signatures)'
const LABEL_PREFIX = 'tech-scan-v1'
const OBS = new Set<Observability>(['ok', 'http_error', 'not_html', 'blocked', 'thin_page'])

export interface TechScan { domain: string; at: number; version: number; path: string; obs: Observability; present: string[]; url: string }
export interface TechChange { tech: string; kind: 'adopted' | 'removed'; before_at: number; first_at: number; confirmed_at: number; checks: number; url: string; version: number }

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
export const isScanDomain = (d: string): boolean => d.length <= 120 && DOMAIN_RE.test(d)
export const day = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString().slice(0, 10)

// The stored form of one crawl's observation (value <= 254, label <= 200 by construction: every key at once is under 150 chars).
export function encodeScan(s: TechScan): { value: string; label: string } | null {
  if (!isScanDomain(s.domain) || !Number.isInteger(s.at) || s.at <= 0) return null
  const keys = [...new Set(s.present.map(techKey).filter((k): k is string => !!k))].sort()
  const path = (s.path || '/').replace(/[|\s]/g, '').slice(0, 30) || '/'
  return { value: `${s.domain}|${s.at}`, label: `${LABEL_PREFIX}|${s.version}|${path}|${s.obs}|${keys.join(',')}` }
}
// Anything malformed is dropped, never trusted.
export function decodeScan(value: string, label: string | null | undefined, sourceUrl: string): TechScan | null {
  const v = /^([a-z0-9.-]+)\|(\d{1,12})$/.exec(value)
  const p = (label ?? '').split('|')
  if (!v || p.length !== 5 || p[0] !== LABEL_PREFIX || !/^\d+$/.test(p[1]) || !OBS.has(p[3] as Observability)) return null
  const present = p[4] ? p[4].split(',').map(techFromKey).filter((n): n is string => !!n) : []
  return { domain: v[1], at: Number(v[2]), version: Number(p[1]), path: p[2] || '/', obs: p[3] as Observability, present, url: sourceUrl }
}

// Changes between comparable observations of ONE domain (scans of other domains are ignored). Only the CURRENT state transition is
// reported per technology: the trailing run of the comparable sequence and the observation just before it.
export function techChanges(scans: TechScan[], domain: string): TechChange[] {
  const ok = scans.filter(s => s.domain === domain && s.obs === 'ok')
  if (ok.length < 2) return []
  const latest = ok.reduce((a, b) => (b.at > a.at ? b : a))
  // Comparable with the latest readable page: same path, same detector version. One observation per timestamp.
  const byAt = new Map<number, TechScan>()
  for (const s of ok) if (s.path === latest.path && s.version === latest.version && !byAt.has(s.at)) byAt.set(s.at, s)
  const seq = [...byAt.values()].sort((a, b) => a.at - b.at)
  if (seq.length < 2) return []
  const out: TechChange[] = []
  for (const tech of [...new Set(seq.flatMap(s => s.present))].sort()) {
    const has = seq.map(s => s.present.includes(tech))
    let k = has.length - 1
    while (k > 0 && has[k - 1] === has[has.length - 1]) k--   // k = first index of the trailing run
    if (k === 0) continue                                      // no earlier comparable observation in the other state
    const run = has.length - k, before = seq[k - 1], first = seq[k]
    // Adoption: never seen on any earlier comparable page (a script that comes back after a gap is the same install, not a new one).
    if (has[has.length - 1] && !has.slice(0, k).some(Boolean)) out.push({ tech, kind: 'adopted', before_at: before.at, first_at: first.at, confirmed_at: first.at, checks: run, url: first.url, version: first.version })
    if (!has[has.length - 1] && run >= 2) out.push({ tech, kind: 'removed', before_at: before.at, first_at: first.at, confirmed_at: seq[k + 1].at, checks: run, url: first.url, version: first.version })
  }
  return out
}

// The stored, human-readable change row: value `<Tech> added|removed`, dated by the first observation that showed the new state.
export function changeRow(c: TechChange): { value: string; label: string; source_url: string; source_date: string } {
  const label = c.kind === 'adopted'
    ? `not seen ${day(c.before_at)}, seen ${day(c.first_at)}; same page, detector v${c.version}, ${TECH_SCOPE}`
    : `seen ${day(c.before_at)}, not seen ${day(c.first_at)} and ${day(c.confirmed_at)}; same page, detector v${c.version}, ${TECH_SCOPE}`
  return { value: `${c.tech} ${c.kind === 'adopted' ? 'added' : 'removed'}`.slice(0, 254), label: label.slice(0, 200), source_url: c.url.slice(0, 500), source_date: day(c.first_at) }
}
export function parseChangeRow(value: string): { tech: string; kind: 'adopted' | 'removed' } | null {
  const m = /^(.+) (added|removed)$/.exec(value)
  return m ? { tech: m[1], kind: m[2] === 'added' ? 'adopted' : 'removed' } : null
}

// Search queries that look for companies BEYOND the already-found set for an explicit technology filter: announcement-style phrases
// a public page would carry. They feed the normal pipeline (every result is still verified, crawled and checked on its own homepage);
// they replace model queries inside the same per-scan search budget, never add to it.
export function techQueries(conds: { tech: string; change: 'uses' | 'adopted' | 'removed'; negated: boolean }[]): string[] {
  const pos = conds.filter(c => !c.negated)
  const from = pos.find(c => c.change === 'removed'), to = pos.find(c => c.change === 'adopted')
  const out: string[] = []
  if (from && to) out.push(`("migrated from ${from.tech} to ${to.tech}" OR "moved from ${from.tech} to ${to.tech}" OR "switched from ${from.tech} to ${to.tech}")`)
  else if (to) out.push(`("migrated to ${to.tech}" OR "moved to ${to.tech}" OR "switched to ${to.tech}")`)
  else if (from) out.push(`("migrated from ${from.tech}" OR "moved off ${from.tech}" OR "switched from ${from.tech}")`)
  for (const c of pos.filter(c => c.change === 'uses')) out.push(`("built on ${c.tech}" OR "powered by ${c.tech}")`)
  return [...new Set(out)].slice(0, 2)
}

// One crawl's observation of a domain's homepage, at the current detector version.
export const scanOf = (domain: string, at: number, obs: Observability, present: string[]): TechScan => ({ domain, at, version: TECH_DETECTOR_VERSION, path: '/', obs, present, url: `https://${domain}/` })
