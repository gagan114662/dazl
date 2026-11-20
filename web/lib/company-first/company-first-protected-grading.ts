// Bounded canonical grade and separate measured hiring fit, after native discovery and literal verification.
// A grade is private evidence, never permission to display, publish or send.
import type Database from 'better-sqlite3'
import { anthropicModel, type Provider } from '../llm/provider.ts'
import { buyerFitPrompt, confirmsFit, FIT_CAP, isHiringLead, nativeBuyerFitTarget, parseBuyerFit } from '../scan/buyer-fit.ts'
import { norm } from '../scan/evidence.ts'
import { normalizeIcp } from '../scan/icp.ts'
import type { VerifyOutcome } from '../scan/runner.ts'
import {
  applyEvidenceQualityGate, applyIcpGate, nativeQueryIcpTextFor, parseScores, scoreLeads, scorePrompt, sellerOfferBlock, WHY_MAX,
} from '../scan/score.ts'
import { modelCostUsd, scanSpendContext, servedCostUsd } from '../scan/spend-cap.ts'
import { parseWindowDays } from '../scan/window.ts'
import { takeCanonicalVerifiedDraft, type CanonicalVerifiedDraftReceipt } from './company-first-canonical-discovery.ts'
import type { Finding } from './company-first-evidence.ts'
import type { ObservedCompanyPage } from './company-first-public-reader.ts'
import { authorizeScorecardSubject, scorecardPinnedBudget } from './scorecard-admission.ts'
import type { AuthorizedScorecardExecution } from './scorecard-dispatch.ts'
import { ownsNewDiscoveryScratch } from './scorecard-evidence-scratch.ts'

const MODEL = 'claude-sonnet-4-5-20250929'
const MAX_TOKENS = 2500, FIT_MAX_TOKENS = 600, FIT_PAGE_CHARS = 2400
type IssuedFinding = Extract<Finding, { state: 'signal_verified' }>
type GradeItem = Readonly<{
  finding: IssuedFinding; verification: CanonicalVerifiedDraftReceipt
  // The trusted private runner observes this verified exact root with the
  // existing guarded reader before the ledger advances. Never search/model text.
  homepage?: ObservedCompanyPage|null
}>
type Draft = Readonly<VerifyOutcome['leads'][number]>
export type CanonicalGradedDraft = Readonly<{
  draft: Draft; evidenceGated: boolean; reservationId: string; actualUsd: number
  buyerFit: 'not_required'|'confirmed'|'held'; buyerFitReservationId: string|null
}>
declare const gradeBrand: unique symbol
export type CanonicalGradedDraftReceipt = Readonly<{ [gradeBrand]: true }>
const receipts = new WeakMap<CanonicalGradedDraftReceipt, {
  primary: Database.Database; scratch: Database.Database; execution: AuthorizedScorecardExecution; finding: IssuedFinding;
  isCurrent: (phase?: 'running'|'done') => boolean; result: CanonicalGradedDraft; used: boolean
}>()

type Row = { id: string; kind: string; attempt: number; status: string; reserve_usd: number; actual_usd: number|null;
  settled_at: number|null; nonce: string|null; lane: number|null }
type Current = { query: string; icp: string; offer: string|null; seller: string|null; sources: string|null }
const isKnownSettlement = (r: Row) => r.status === 'settled' && r.settled_at !== null &&
  r.actual_usd !== null && Number.isFinite(r.actual_usd) && r.actual_usd >= 0 && r.actual_usd <= r.reserve_usd
const sameRows = (a: Row[], b: Row[]) => JSON.stringify(a) === JSON.stringify(b)

function fitHomepage(finding: IssuedFinding, page: ObservedCompanyPage|null|undefined): string|null {
  if (!page || page.contentType !== 'text/html' || typeof page.visibleText !== 'string') return null
  const root = new URL('/',finding.site.website)
  if (root.protocol !== 'https:' || root.username || root.password || root.port ||
    page.url !== root.href || page.finalUrl !== root.href || page.visibleText.trim().length < 100 ||
    /\b(?:captcha|verify you are (?:a )?human|access denied)\b/i.test(page.visibleText.slice(0,500))) return null
  const excerpt = page.visibleText.replace(/<<<|>>>/g,' ').slice(0,FIT_PAGE_CHARS)
  const company = norm(finding.name).trim()
  if (company.length < 2 || !(` ${norm(excerpt).trim()} `).includes(` ${company} `)) return null
  return excerpt
}

export function isCurrentCanonicalGrading(receipt: CanonicalGradedDraftReceipt, primary: Database.Database,
  scratch: Database.Database, execution: AuthorizedScorecardExecution, finding: IssuedFinding): boolean {
  const entry = receipts.get(receipt)
  if (!entry || entry.primary !== primary || entry.scratch !== scratch || entry.execution !== execution || entry.finding !== finding) return false
  try { return entry.isCurrent() } catch { return false }
}

// Only a grade already issued in the running phase may justify the later
// local done transition. This is read-only and cannot admit a provider call.
export function isFinalCanonicalGrading(receipt: CanonicalGradedDraftReceipt, primary: Database.Database,
  scratch: Database.Database, execution: AuthorizedScorecardExecution, finding: IssuedFinding): boolean {
  const entry = receipts.get(receipt)
  if (!entry || entry.primary !== primary || entry.scratch !== scratch || entry.execution !== execution || entry.finding !== finding) return false
  try { return entry.isCurrent('done') } catch { return false }
}

export function takeCanonicalGradedDraft(receipt: CanonicalGradedDraftReceipt, primary: Database.Database,
  scratch: Database.Database, execution: AuthorizedScorecardExecution, finding: IssuedFinding): CanonicalGradedDraft|null {
  const entry = receipts.get(receipt)
  if (!entry || entry.used || !isCurrentCanonicalGrading(receipt,primary,scratch,execution,finding)) return null
  entry.used = true
  return entry.result
}

export async function gradeCanonicalVerifiedDraft(primary: Database.Database, scratch: Database.Database,
  execution: AuthorizedScorecardExecution, finding: IssuedFinding, verification: CanonicalVerifiedDraftReceipt,
  key: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<CanonicalGradedDraftReceipt|null> {
  return (await gradeCanonicalVerifiedDrafts(primary,scratch,execution,[{finding,verification}],key,signal,fetchImpl))?.[0] ?? null
}

export async function gradeCanonicalVerifiedDrafts(primary: Database.Database, scratch: Database.Database,
  execution: AuthorizedScorecardExecution, items: readonly GradeItem[], key: string, signal: AbortSignal,
  fetchImpl: typeof fetch = fetch): Promise<readonly CanonicalGradedDraftReceipt[]|null> {
  const x = execution.ticket, ctx = scanSpendContext()
  if (items.length < 1 || items.length > 5 || new Set(items.map(i => i.finding.signal.sourceUrl)).size !== items.length ||
    signal.aborted || !key || x.lane !== 'new' || execution.vendor !== 'anthropic' || execution.funding !== 'workspace_owned' ||
    !ownsNewDiscoveryScratch(scratch, primary, x) || ctx?.db !== primary ||
    ctx.jobId !== x.jobId || ctx.tenantId !== x.tenantId || ctx.attempt !== x.attempt ||
    ctx.claudeOnly !== true || ctx.accountLimits == null || ctx.scorecard?.ticket !== x || ctx.scorecard.lane !== 'new') return null
  try {
    const currentSubject = (phase: 'running'|'done' = 'running') => {
      if (signal.aborted || Date.now() >= x.expiresAt || !ownsNewDiscoveryScratch(scratch, primary, x) ||
        !primary.prepare(`
          SELECT 1 FROM scan_jobs j JOIN company_scorecard_claims c ON c.nonce=j.company_scorecard_claim_nonce
          JOIN company_scorecard_cohorts p ON p.cohort=c.cohort AND p.tenant_id=c.tenant_id
          JOIN organizations o ON o.id=p.tenant_id JOIN memberships m ON m.tenant_id=o.id AND m.member_id=p.actor_id AND m.role='owner'
          WHERE j.id=? AND j.user_id=? AND j.attempts=? AND j.status='running' AND j.error IS NULL
            AND j.company_scorecard_dispatch_release=? AND j.company_scorecard_dispatch_started_at IS NOT NULL
            AND j.funded_by='user' AND j.run_budget=? AND c.job_id=j.id AND c.tenant_id=j.user_id AND c.attempt=j.attempts
            AND c.status='running' AND c.lane=1 AND c.nonce=? AND c.ordinal=? AND c.expires_at=? AND c.subject_mac=?
            AND p.cohort=? AND p.next_ordinal=c.ordinal AND p.release=? AND p.actor_id=? AND p.workspace_revision=? AND p.roster=?
            AND o.company_first_scorecard_enabled=1 AND o.company_first_scorecard_revision=p.workspace_revision
            AND NOT EXISTS(SELECT 1 FROM tenant_tombstones d WHERE d.deleted_tenant IN(o.id,m.member_id))`)
          .get(x.jobId,x.tenantId,x.attempt,x.release,scorecardPinnedBudget(),x.nonce,x.ordinal,x.expiresAt,x.subjectMac,
            x.cohort,x.release,x.actorId,x.workspaceRevision,JSON.stringify(x.presets))) return null
      const r = scratch.prepare(`SELECT query,icp,offer,seller,sources FROM scan_jobs
        WHERE id=? AND user_id='private-scratch' AND attempts=? AND status=? AND error IS NULL AND run_budget=?
          AND (status='running' OR (claimed_at IS NULL AND finished_at IS NOT NULL))`)
        .get(x.jobId,x.attempt,phase,scorecardPinnedBudget()) as Current|undefined
      return r ? authorizeScorecardSubject(x,r)?.subject ?? null : null
    }
    const ledger = () => primary.prepare(`SELECT s.id,s.kind,s.attempt,s.status,s.reserve_usd,s.actual_usd,s.settled_at,b.nonce,b.lane
      FROM scan_spend_calls s LEFT JOIN company_scorecard_calls b ON b.reservation_id=s.id AND b.tenant_id=s.user_id
      WHERE s.user_id=? AND s.scan_job_id=? AND s.status<>'refused' ORDER BY s.id`).all(x.tenantId,x.jobId) as Row[]
    const belongs = (r: Row) => r.attempt === x.attempt && r.nonce === x.nonce && r.lane === 1
    const batch = items.map(({finding,verification,homepage}) => ({finding,verification,homepage:fitHomepage(finding,homepage)}))
    const subject = currentSubject()
    const before = ledger()
    if (!subject || !before.length || before.some(r => !belongs(r) || r.kind !== 'llm.anthropic.web_search' || !isKnownSettlement(r))) return null
    const verified = batch.map(item => takeCanonicalVerifiedDraft(item.verification,scratch,execution,item.finding))
    if (verified.some(r => r === null)) return null
    const drafts = verified.filter((r): r is Draft => r !== null)
    const icp = normalizeIcp(JSON.parse(subject.icp))
    if (!icp || !(subject.offer || subject.seller)) return null
    const target = nativeQueryIcpTextFor(icp,subject.query) + sellerOfferBlock(subject.offer ?? subject.seller)
    const now = new Date()
    const prompt = scorePrompt(target,drafts,now)
    const real = anthropicModel(MODEL)
    async function measured(asked: string, max: number, prior: Row[]) {
      if (!currentSubject() || !sameRows(ledger(),prior)) throw new Error('grading_quote_changed')
      const quote = modelCostUsd(MODEL,asked,max)
      const ids = new Set(prior.map(r => r.id))
      const completionRow = (rows: Row[]) => {
        const added = rows.filter(r => !ids.has(r.id))
        if (added.length !== 1 || !sameRows(rows.filter(r => ids.has(r.id)),prior)) return null
        const r = added[0]
        return belongs(r) && r.kind === 'llm.anthropic' && r.reserve_usd === quote ? r : null
      }
      let sentId: string|null = null
      const bounded: typeof fetch = async (url,init) => {
        const r = completionRow(ledger())
        if (sentId || !currentSubject() || !r || r.status !== 'reserved' || r.actual_usd !== null || r.settled_at !== null ||
          url !== 'https://api.anthropic.com/v1/messages' || init?.method !== 'POST' ||
          init.body !== JSON.stringify({ model: MODEL, max_tokens: max, messages: [{ role: 'user', content: asked }] }))
          throw new Error('grading_transport_refused')
        const remaining = x.expiresAt-Date.now()
        if (remaining <= 0) throw new Error('grading_transport_expired')
        sentId = r.id
        return fetchImpl(url,{ ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(remaining), ...(init.signal ? [init.signal] : [])]), redirect:'error' })
      }
      let answer
      try { answer = await real.completeDetailed!(key,asked,bounded,max) }
      catch { throw new Error('grading_provider_unavailable') }
      if (answer.model !== MODEL || answer.stop !== 'end_turn') throw new Error('grading_response_unusable')
      const actualUsd = servedCostUsd(answer.model,answer.usage)
      const after = ledger()
      const r = completionRow(after)
      if (!r || !sentId || r.id !== sentId || actualUsd === null || !isKnownSettlement(r) ||
        Math.abs(r.actual_usd! - actualUsd) > 1e-9 || !currentSubject()) throw new Error('grading_settlement_unknown')
      return { text:answer.text, id:r.id, actualUsd, after }
    }

    let gradeCall: Awaited<ReturnType<typeof measured>>|undefined
    const provider: Provider = {
      research: real.research,
      async complete(apiKey, asked, _fetch, max) {
        if (apiKey !== key || asked !== prompt || max !== MAX_TOKENS) throw new Error('grading_quote_changed')
        const call = await measured(asked,max,before)
        // Prevent scoreLeads's existing parse-failure diagnostic from logging
        // private provider text on the scorecard path.
        if (!parseScores(call.text,drafts.length)) throw new Error('grading_response_unusable')
        gradeCall = call
        return call.text
      },
    }
    const scores = await scoreLeads(provider,key,target,drafts,undefined,{ now, windowDays: parseWindowDays(subject.query) ?? icp.window_days ?? null })
    if (!scores || !gradeCall) return null
    const grade = gradeCall
    const enriched = applyIcpGate(scores,icp).map((g,i) => {
      const draft = { ...drafts[i], fit:g.fit, intent:g.intent, action:g.action, why:g.why,
        signals:JSON.stringify(g.signals), icp_match:JSON.stringify(g.match) }
      const evidenceGated = applyEvidenceQualityGate([draft]) !== 0
      return { draft, evidenceGated }
    })
    const needsFit = enriched.map(({draft}) => draft.fit >= 4 && isHiringLead(draft))
    const fitItems = enriched.flatMap(({draft},i) => {
      const homepage = batch[i].homepage
      return needsFit[i] && homepage ? [{ n:i+1, company:draft.company, homepage }] : []
    })
    const fit = fitItems.length ? await measured(
      buyerFitPrompt(nativeBuyerFitTarget(icp,subject.query,subject.offer ?? subject.seller),fitItems),FIT_MAX_TOKENS,grade.after,
    ) : null
    const finalRows = fit?.after ?? grade.after
    if (!currentSubject() || !sameRows(ledger(),finalRows)) return null
    const answers = fit ? parseBuyerFit(fit.text) : null
    const prompts = new Map(fitItems.map(it => [it.n,it.homepage]))
    const isCurrent = (phase: 'running'|'done' = 'running') => !!currentSubject(phase) && sameRows(ledger(),finalRows)
    return Object.freeze(enriched.map(({draft,evidenceGated},i) => {
      let buyerFit: CanonicalGradedDraft['buyerFit'] = 'not_required'
      const home = prompts.get(i+1)
      if (needsFit[i]) {
        const a = answers?.get(i+1)
        if (home && confirmsFit(a,home)) {
          buyerFit = 'confirmed'
          draft.why = `Company site confirms fit: "${a!.quote}". ${draft.why}`.trim().slice(0,WHY_MAX)
        } else {
          buyerFit = 'held'
          draft.fit = Math.min(draft.fit,FIT_CAP)
          draft.why = `Buyer fit unconfirmed: ${home ? 'no verified match on the company home page.' : 'the company home page could not be verified.'} A job posting alone is not a buyer signal. ${draft.why}`.trim().slice(0,WHY_MAX)
        }
      }
      const receipt = Object.freeze({}) as CanonicalGradedDraftReceipt
      const result = Object.freeze({ draft:Object.freeze(draft), evidenceGated, reservationId:grade.id, actualUsd:grade.actualUsd,
        buyerFit, buyerFitReservationId:home ? fit?.id ?? null : null })
      receipts.set(receipt,{ primary,scratch,execution,finding:batch[i].finding,result,isCurrent,used:false })
      return receipt
    }))
  } catch { return null }
}
