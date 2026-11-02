// The first intelligence-layer vertical: explicit seller decisions -> durable history -> bounded scoped recall
// -> editable targeting. This is NOT autonomous learning, lead qualification, consent or a source verifier.
import { createHash } from 'node:crypto'
import type { Db, Param } from '../db/client.ts'
import type { Icp, IcpResearch, ResearchedHyp } from './icp.ts'
import { norm } from './evidence.ts'

export const INTELLIGENCE_ONTOLOGY = {
  seller: 'The tenant selling an offer; not the prospect.',
  offer: 'A named seller product or service. Decisions never cross offer IDs.',
  buyer: 'A seller-reviewed target role or segment, not proof of employment or authority.',
  account: 'A prospect company bound to its own identity evidence, never a customer mentioned in a case study.',
  event: 'A claim about that account with a separate occurrence time and checked time.',
  contact: 'A person or channel with separate employer, role, publication and deliverability proof.',
  decision: 'An authenticated workspace actor explicitly adding or dismissing seller targeting. Not a web fact.',
} as const
export const RECALL_LIMIT = 120
export const RECALL_BYTES = 12_000
export interface DecisionInput { offer: string; hypothesis: string; action: 'confirm' | 'reject' }
export interface SellerDecision {
  id: string; tenant_id: string; actor_id: string; job_id: string; site: string; offer_id: string;
  hypothesis_id: string; kind: Exclude<ResearchedHyp['k'], 'offer'>; text: string; action: 'confirm' | 'reject';
  source_url: string | null; source_quote: string | null; source_checked_at: number | null; created_at: number; version: 1
}
export interface RecallTrace {
  version: 1; mode: 'seller_decisions'; site: string; considered: number; selected: string[];
  superseded: string[]; omitted: string[]; truncated: boolean;
  trust: 'seller_targeting_only'; source_freshness: 'not_reused_as_current_proof'
}
export interface DecisionPack { decisions: SellerDecision[]; trace: RecallTrace }

export function siteKey(raw: string): string | null {
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`)
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !u.hostname.includes('.')) return null
    return u.hostname.toLowerCase().replace(/^www\./, '')
  } catch { return null }
}

// Only an explicit action payload is authorship evidence. icp_inferred=0, a submitted profile, a 'reviewed' status
// or a model grade are NOT enough. The route supplies actor/tenant from requireUser(), never from the body.
export function decisionRows(input: unknown, research: IcpResearch | undefined,
  scope: { tenant: string; actor: string; job: string; now: number }, profile?: Icp): SellerDecision[] {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > 24 || !research || !siteKey(research.site)) throw new Error('invalid_research_decisions')
  const seen = new Set<string>()
  return input.map(raw => {
    const d = raw as Partial<DecisionInput> | null
    const h = research.hyps.find(h => h.i === d?.hypothesis && h.o === d?.offer)
    if (!h || h.k === 'offer' || (d?.action !== 'confirm' && d?.action !== 'reject')) throw new Error('invalid_research_decisions')
    const field = fields[h.k as keyof typeof fields]
    if (field && profile) {
      const present = profile[field].some(t => norm(t) === norm(h.t))
      if ((d.action === 'confirm') !== present) throw new Error('invalid_research_decisions')
    }
    // A UI action changes the profile as well as its provenance block. Forged/mismatched actions fail closed.
    const key = `${h.o}|${h.i}`
    if (seen.has(key)) throw new Error('invalid_research_decisions')
    seen.add(key)
    const id = createHash('sha256').update(JSON.stringify([scope.tenant, scope.job, h.o, h.i])).digest('hex')
    return { id, tenant_id: scope.tenant, actor_id: scope.actor, job_id: scope.job, site: siteKey(research.site)!,
      offer_id: h.o, hypothesis_id: h.i, kind: h.k, text: h.t, action: d.action,
      // Retained as historical client-submitted research provenance, never promoted as fresh page verification.
      source_url: h.u, source_quote: h.q, source_checked_at: h.at, created_at: scope.now, version: 1 as const }
  })
}
export const SELLER_DECISION_INSERT = `INSERT INTO seller_decisions (id,tenant_id,actor_id,job_id,site,offer_id,hypothesis_id,kind,text,action,source_url,source_quote,source_checked_at,created_at,version)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
export const sellerDecisionArgs = (r: SellerDecision): Param[] => [r.id,r.tenant_id,r.actor_id,r.job_id,r.site,r.offer_id,r.hypothesis_id,r.kind,r.text,r.action,r.source_url,r.source_quote,r.source_checked_at,r.created_at,r.version]
export async function writeSellerDecisions(db: Db, rows: SellerDecision[]): Promise<void> {
  await db.tx(function* (t) { for (const r of rows) yield* t.run(SELLER_DECISION_INSERT, sellerDecisionArgs(r)) })
}
const SELECT = `SELECT id,tenant_id,actor_id,job_id,site,offer_id,hypothesis_id,kind,text,action,source_url,source_quote,source_checked_at,created_at,version
 FROM seller_decisions WHERE tenant_id = ? AND site = ? ORDER BY created_at DESC,action DESC,id DESC LIMIT ?`
export async function recallSellerDecisions(db: Db, tenant: string, site: string): Promise<DecisionPack> {
  const key = siteKey(site)
  if (!key) throw new Error('invalid_research_site')
  // Scope in SQL BEFORE the bounded candidate selection, never fetch everyone then filter top-k in JS.
  const rows = await db.all<SellerDecision>(SELECT, [tenant, key, RECALL_LIMIT + 1])
  return assembleDecisionPack(rows, tenant, key)
}
export function assembleDecisionPack(rows: SellerDecision[], tenant: string, site: string): DecisionPack {
  const trace: RecallTrace = { version: 1, mode: 'seller_decisions', site, considered: 0, selected: [], superseded: [], omitted: [], truncated: false,
    trust: 'seller_targeting_only', source_freshness: 'not_reused_as_current_proof' }
  const decisions: SellerDecision[] = [], seen = new Set<string>()
  let bytes = 0
  for (const r of rows) {
    if (r.tenant_id !== tenant || r.site !== site) continue
    if (++trace.considered > RECALL_LIMIT) { trace.truncated = true; break }
    const k = `${r.offer_id}|id:${r.hypothesis_id}`
    const textKey = `${r.offer_id}|${r.kind}|text:${norm(r.text)}`
    if (seen.has(k) || seen.has(textKey)) { trace.superseded.push(r.id); continue }
    seen.add(k); seen.add(textKey) // a too-large newer decision still suppresses its older value
    const size = Buffer.byteLength(JSON.stringify(r))
    if (bytes + size > RECALL_BYTES) { trace.omitted.push(r.id); trace.truncated = true; continue }
    bytes += size; decisions.push(r); trace.selected.push(r.id)
  }
  return { decisions, trace }
}

const fields = { persona: 'who', industry: 'industries', size: 'sizes', location: 'where', disqualifier: 'exclude' } as const
// Reuse decisions as targeting, not as current source facts. Explicit rejections beat model recrawl text even if
// the new hypothesis ID changed, when the normalized statement and offer agree. Confirmations keep their original ID.
// All recalled decisions remain visible in the research review block, with historical quotes removed to avoid the
// UI's 'on your site' label claiming that a seller edit was proven by an older page.
export function reuseSellerDecisions(icp: Icp, pack: DecisionPack, offerName: string): Icp {
  const r = icp.research
  if (!r || siteKey(r.site) !== pack.trace.site) return icp
  const decisions = pack.decisions.filter(d => r.offers.some(o => o.i === d.offer_id))
  const hyps = r.hyps.map(h => {
    const d = decisions.find(d => d.offer_id === h.o && (d.hypothesis_id === h.i || (d.kind === h.k && norm(d.text) === norm(h.t))))
    return d ? { ...h, t: d.text, s: d.action === 'reject' ? 'rejected' as const : 'reviewed' as const, u: null, q: null, at: null } : h
  })
  for (const d of decisions) if (!hyps.some(h => h.o === d.offer_id && (h.i === d.hypothesis_id || (h.k === d.kind && norm(h.t) === norm(d.text))))) hyps.push({ i: d.hypothesis_id, o: d.offer_id, k: d.kind, t: d.text,
    s: d.action === 'reject' ? 'rejected' : 'reviewed', u: null, q: null, at: null })
  const matches = r.offers.filter(o => norm(o.n) === norm(offerName))
  // No fuzzy selection. Multiple products never donate their buyer list to one flat draft.
  const selected = matches.length === 1 ? matches[0] : r.offers.length === 1 && !offerName ? r.offers[0] : null
  const out = { ...icp, research: { ...r, hyps } }
  if (!selected) return out
  for (const d of decisions.filter(d => d.offer_id === selected.i)) {
    const f = fields[d.kind as keyof typeof fields]
    if (!f) continue
    out[f] = out[f].filter(t => norm(t) !== norm(d.text))
    if (d.action === 'confirm' && out[f].length < (f === 'sizes' ? 4 : 6)) out[f] = [...out[f], d.text]
  }
  return out
}
