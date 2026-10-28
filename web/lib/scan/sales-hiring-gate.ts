// "Seed funding AND hiring sales": a request whose play needs an event beyond hiring plus sales / GTM hiring is not answered by the
// funding quote alone. After the contact crawl has bound each lead to its company domain, a verified lead keeps its place only when
//   (a) its own saved quote already names a sales / GTM hiring (the source says it), or
//   (b) a dated (inside the window, default 90 days) sales / GTM posting sits on a public Greenhouse / Lever / Ashby board bound to the
//       lead's own domain (lib/signals/ats-gtm.ts).
// Otherwise it moves to review with the distinct reason `no_sales_hiring_evidence` and says so on its card. This only ADDS a requirement:
// the quote, date, identity and place gates that put the lead there are not touched, and nothing here promotes a review row.
import type Database from 'better-sqlite3'
import { addEnrichment, audit } from '../connectors/store.ts'
import { atsGtmHiring, isGtmRole, BOARD_LABEL } from '../signals/ats-gtm.ts'
import { domainRelationship } from '../signals/domain-basis.ts'
import { needsEventBeyondHiring, showsEventBeyondHiring, mentionsFunding } from '../search/page-class.ts'
import { parseWindowDays } from './window.ts'
import { WHY_MAX } from './score.ts'

export const NO_SALES_HIRING = 'no_sales_hiring_evidence'
export const NO_EVENT = 'no_event_evidence'
const HIRING_WORDS = /\bhir(?:e|es|ed|ing)\b|\brecruit\w*|\b(?:new|open|several|two|three|\d+)\s+(?:sales\s+|gtm\s+)?(?:role|position|opening)s?\b|\bjoin(?:ing)?\s+(?:our|the)\s+(?:sales|gtm)/i
const MAX_BOARD_LOOKUPS = 20 // network lookups per run; a lead beyond it is NOT passed, it is held as unchecked

interface JobLike { id: string; user_id: string; query?: string | null; icp?: string | null }

export function salesHiringRequired(query: string | null | undefined, icp: string | null | undefined): boolean {
  let signals: string[] = []
  try { const j = icp ? JSON.parse(icp) as { signals?: unknown } : null; if (Array.isArray(j?.signals)) signals = j!.signals.filter((x): x is string => typeof x === 'string') } catch { /* no profile */ }
  const text = [...signals, query ?? ''].join(' . ')
  return needsEventBeyondHiring(signals, query ?? '') && HIRING_WORDS.test(text) && isGtmRole(text.replace(/\b(?:hir(?:e|es|ed|ing)|recruit\w*)\b/gi, ' '))
}
// The source quote itself says the company is hiring for a sales / GTM role.
// The saved quote / claim itself shows the event half (funding, an opening ...): a job ad alone does not show that a company raised money.
// When the request asks for FUNDING, only a funding mention counts (an office opening is not a raise); otherwise any event beyond hiring does.
export const quoteShowsEvent = (excerpt: string | null, signal: string | null, fundingAsked = false, company?: string | null): boolean => { void signal; const t = excerpt ?? ''
  // The funding / event sentence must be about THIS company: "Othercorp raised a seed round" is not the lead's raise.
  return clauses(t).some(c => (fundingAsked ? mentionsFunding(c) : showsEventBeyondHiring(c)) && !namesOtherEntity(c.slice(0, Math.max(0, c.search(/\b(?:rais|fund|seed|series|invest|round|open|launch|expan|announc)/i))), company)) }
export const requestAsksFunding = (query: string | null | undefined, icp: string | null | undefined): boolean => { let sig = ''; try { const j = icp ? JSON.parse(icp) as { signals?: unknown } : null; if (Array.isArray(j?.signals)) sig = j!.signals.filter((x): x is string => typeof x === 'string').join(' . ') } catch { /* none */ } return mentionsFunding(`${sig} . ${query ?? ''}`) }
// Affirmative hiring proof, not keyword co-occurrence. A CLAUSE (split on sentence ends and but / however / while / although / yet) must say the lead's OWN
// company is hiring, now, for a sales / GTM role:
//   - not negated or denied ("not hiring", "no plans to hire", "hiring freeze", "denies hiring", "rules out", "rejects reports of");
//   - not conditional, hypothetical, planned or hearsay ("only if", "once", "would", "may", "plans to", "will", "reportedly");
//   - not past ("was hiring", "previously", "hired");
//   - the sales noun must be the HEAD of the object ("hiring sales tax accountants" and "a sales operations accountant" are not sales roles);
//   - the subject must be the lead's company: another named company in front of the verb ("Separately, Othercorp is hiring sales staff") is not it.
// Anything this cannot read as plainly affirmative fails closed.
const NEGATED = /\b(?:not|no|never|none|nor|without|isn'?t|aren'?t|wasn'?t|won'?t|doesn'?t|don'?t|didn'?t|hasn'?t|haven'?t|can'?t|cannot|zero|freeze|frozen|paused?|halt(?:ed|s)?|suspend(?:ed|s)?|cancel(?:l?ed|s)?|rescind(?:ed|s)?|scrapp(?:ed|ing)|shelv(?:ed|ing)|delay(?:ed|ing)?|postpon(?:ed|ing)|abandon(?:ed|ing)|ruled?\s+out|rules?\s+out|stopped|stops?|layoffs?|laid\s+off|cut(?:ting|s)?|den(?:y|ies|ied|ying)|refut\w+|reject\w*|dismiss\w*|debunk\w*|disput\w+|disclaim\w*|untrue|false|incorrect|wrong|rumou?r\w*|reportedly|allegedly|supposedly|reports?\s+(?:of|that|say)|unconfirmed)\b/i
const HYPOTHETICAL = /\b(?:if|only\s+if|once|when|whenever|unless|until|provided|assuming|should|would|could|may|might|will|shall|plans?\s+to|planning\s+to|plan\s+is|intends?|intending|aims?\s+to|hopes?\s+to|expects?\s+to|expected\s+to|later\s+this|next\s+(?:year|quarter|month)|eventually|potentially|possibly|pending|depends?|subject\s+to|after\s+(?:the\s+)?(?:close|funding)|in\s+the\s+future)\b/i
const PAST = /\b(?:was|were|had|used\s+to|previously|formerly|last\s+(?:year|quarter|month)|no\s+longer|stopped|hired|recruited|added)\b/i
const HIRE_VERB = '(?:hir(?:e|es|ing)|recruit(?:s|ing)?|seek(?:s|ing)?|look(?:s|ing)\\s+(?:to\\s+hire|for)|add(?:s|ing)|building\\s+out)'
const FILLER = '(?:(?:a|an|our|its|their|the|first|new|senior|junior|founding|key|two|three|four|five|six|\\d+|more|several|some|additional|dedicated|experienced|full[-\\s]?time|remote|enterprise|inbound|outbound|lead|for|in|across|into|within|to\\s+the|to\\s+our|to\\s+build\\s+(?:out\\s+)?(?:our|its|the))\\s+){0,6}'
const GTM_OBJECT = '(?:head\\s+of\\s+(?:sales|growth|revenue)|account\\s+(?:executive|manager|director)s?|aes?|sdrs?|bdrs?|sales(?:\\s+(?:reps?|representatives?|people|persons?|staff|team|leaders?|managers?|directors?|engineers?|development\\s+reps?|hires?|professionals?|executives?|talent|roles?|positions?))?|business\\s+development(?:\\s+(?:reps?|representatives?|managers?|leads?))?|go[-\\s]to[-\\s]market|gtm|revenue\\s+(?:leaders?|team|roles?)|growth\\s+(?:leaders?|team|marketers?)|customer\\s+success(?:\\s+(?:managers?|reps?|team))?|solutions?\\s+(?:engineer|consultant)s?|vp\\s+(?:of\\s+)?sales|demand\\s+gen\\w*)'
// The object must END there (end of clause, punctuation, or a function word): "sales" followed by "tax accountants" / "operations accountant" is a modifier of another role.
const OBJECT_END = '(?=\\s*(?:$|[,:()-]|\\s(?:and|or|to|for|in|across|at|this|next|now|as|with|from|who|that|ahead|so|because|following|based|located|remote|globally|worldwide|today|currently)\\b))'
const HIRING_VERB_OBJECT = new RegExp(`\\b${HIRE_VERB}\\s+${FILLER}${GTM_OBJECT}${OBJECT_END}`, 'i')
const OPEN_ROLE = /\b(?:open|new|several|two|three|\d+)\s+(?:[a-z-]+\s+){0,3}(?:roles?|positions?|openings?|vacanc(?:y|ies))\b/i
const FIRST_HIRE = /\b(?:first|new|key)\s+(?:sales|ae|sdr|bdr|gtm|account\s+executive)\s+hire\b|\bjoin(?:ing)?\s+(?:our|the)\s+(?:sales|gtm)\s+team\b/i
const clauses = (t: string) => t.split(/[.;!?\n]+|\s(?:but|however|while|although|though|yet)\s/i).map(x => x.trim()).filter(Boolean)
// Capitalised words that are not a company: sentence openers, places and stage words that may stand in front of the verb.
const NOT_ENTITY = new Set(['the', 'it', 'its', 'we', 'our', 'they', 'their', 'now', 'also', 'still', 'currently', 'and', 'then', 'today', 'london', 'uk', 'nyc', 'new', 'york', 'us', 'saas', 'b2b', 'seed', 'series', 'startup', 'company', 'team', 'founder', 'founders', 'ceo', 'cto', 'cofounder', 'inc', 'ltd', 'llc', 'limited', 'plc', 'a', 'an', 'in', 'at', 'to', 'of', 'for', 'is', 'are', 'has', 'have', 'recently', 'just', 'actively', 'already', 'additionally', 'meanwhile', 'following'])
const wordsOf = (x: string) => x.toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean)
// True when text in FRONT of the hiring verb names a company other than the lead ("Separately, Othercorp is hiring ..."). Without a company there is nothing to bind to.
export function namesOtherEntity(prefix: string, company: string | null | undefined): boolean {
  if (!company) return false
  const own = new Set(wordsOf(company))
  for (const m of prefix.matchAll(/\b[A-Z][A-Za-z0-9'’-]*/g)) {
    const w = m[0].toLowerCase().replace(/['’]s$/, '')
    if (NOT_ENTITY.has(w) || own.has(w)) continue
    if (m.index === 0 && /^(?:separately|meanwhile|elsewhere|additionally|furthermore|however|but|also|today|now|recently)$/.test(w)) continue
    return true
  }
  return false
}
export const affirmativeSalesHiring = (text: string | null, company?: string | null): boolean => clauses(text ?? '').some(c => {
  if (NEGATED.test(c) || HYPOTHETICAL.test(c) || PAST.test(c)) return false
  const m = HIRING_VERB_OBJECT.exec(c)
  if (m) return !/\bsalesforce\b|\bsales\s*tax\b/i.test(m[0]) && !namesOtherEntity(c.slice(0, m.index), company)
  const o = OPEN_ROLE.exec(c) ?? FIRST_HIRE.exec(c)
  return !!o && isGtmRole(c) && !namesOtherEntity(c.slice(0, o.index), company)
})
export const quoteNamesSalesHiring = (excerpt: string | null, signal: string | null, company?: string | null): boolean => { void signal; return affirmativeSalesHiring(excerpt, company) } // the VERIFIED quote only: the model's claim is not evidence

export async function applySalesHiringGate(db: Database.Database, job: JobLike, fetchImpl: typeof fetch = fetch, opts: { now?: number; hiringKeys?: Map<string, { url: string; date: string | null }>; eventKeys?: Set<string>; fundingKeys?: Set<string> } = {}): Promise<{ required: boolean; checked: number; passed: number; demoted: number }> {
  const none = { required: false, checked: 0, passed: 0, demoted: 0 }
  if (!salesHiringRequired(job.query, job.icp)) return none
  const windowDays = parseWindowDays(job.query ?? '') ?? 90
  const fundingAsked = requestAsksFunding(job.query, job.icp)
  const now = Math.floor((opts.now ?? Date.now()) / 1000)
  const leads = db.prepare(
    `SELECT id, company, company_domain, evidence_excerpt, signal, why, dedup_key FROM leads
     WHERE scan_job_id = ? AND review_reason IS NULL AND confidence IS NOT NULL AND human_confirmed_at IS NULL AND company <> '' ORDER BY score DESC`,
  ).all(job.id) as { id: string; company: string; company_domain: string | null; evidence_excerpt: string | null; signal: string; why: string | null; dedup_key: string | null }[]
  const setWhy = db.prepare('UPDATE leads SET why = ? WHERE id = ?')
  const demote = db.prepare('UPDATE leads SET review_reason = ?, confidence = NULL, why = ? WHERE id = ? AND review_reason IS NULL')
  const counts = db.prepare('UPDATE scan_jobs SET verified = MAX(COALESCE(verified, 0) - 1, 0), needs_review = COALESCE(needs_review, 0) + 1 WHERE id = ?')
  let passed = 0, demoted = 0, lookups = 0
  const demoteEvent = db.prepare('UPDATE leads SET review_reason = ?, confidence = NULL, why = ? WHERE id = ? AND review_reason IS NULL')
  for (const l of leads) {
    // The event half first: a hiring page alone (a job ad) does not show seed funding / an opening, whatever it says about the company.
    if (!quoteShowsEvent(l.evidence_excerpt, l.signal, fundingAsked, l.company) && !(l.dedup_key && (fundingAsked ? opts.fundingKeys : opts.eventKeys)?.has(l.dedup_key))) {
      if (demoteEvent.run(NO_EVENT, (`No event evidence: the source quote shows hiring but not the funding or event the request asks for. ` + (l.why ?? '')).trim().slice(0, WHY_MAX), l.id).changes) { counts.run(job.id); demoted++ }
      continue
    }
    if (quoteNamesSalesHiring(l.evidence_excerpt, l.signal, l.company)) { passed++; continue }
    // Another VERIFIED candidate for the same company (kept out as a duplicate) is the one whose own quote names the sales hiring.
    const other = l.dedup_key ? opts.hiringKeys?.get(l.dedup_key) : undefined
    if (other) {
      let host = ''; try { host = new URL(other.url).hostname.replace(/^www\./, '') } catch { /* keep blank */ }
      setWhy.run((`Hiring sales: named in a verified source${host ? ` (${host})` : ''}${other.date ? `, dated ${other.date}` : ''}. ${l.why ?? ''}`).trim().slice(0, WHY_MAX), l.id)
      passed++; continue
    }
    if (l.company_domain && lookups >= MAX_BOARD_LOOKUPS) {
      // A processing limit never lets a lead through unproven: it is held, and the card says it was not checked (unknown, not absent).
      if (demote.run(NO_SALES_HIRING, (`No sales-hiring evidence: not checked - this scan had more leads than the job-board lookup limit (${MAX_BOARD_LOOKUPS}). ` + (l.why ?? '')).trim().slice(0, WHY_MAX), l.id).changes) { counts.run(job.id); demoted++ }
      continue
    }
    if (l.company_domain) lookups++
    const g = l.company_domain ? await atsGtmHiring(l.company, l.company_domain, fetchImpl, { windowDays, now: (opts.now ?? Date.now()) }).catch(() => null) : null
    // The board must be the lead's OWN: under a domain the cited page is hosted on (or the user confirmed). A board found through a domain matched only
    // by company name (a probe, a link label) could belong to a larger same-name company: its roles are not this lead's hiring.
    // The board is bound to the lead's domain when the cited page is hosted on it / the user confirmed it, or when the board's OWN postings name that same
    // domain (a company-site address or link inside the posting text).
    const heuristic = !!g && g.via === 'domain' && domainRelationship(db, job.user_id, l.id, l.company_domain) !== 'established' && !(g.domain && l.company_domain && g.domain.replace(/^www\./, '') === l.company_domain.replace(/^www\./, ''))
    if (g && g.via === 'domain' && !heuristic) {
      const p = g.postings[0]
      const line = `Hiring sales: ${p.title} posted ${p.date} on its ${BOARD_LABEL[g.board]} job board (${l.company_domain}). `
      setWhy.run((line + (l.why ?? '')).trim().slice(0, WHY_MAX), l.id)
      addEnrichment(db, job.user_id, l.id, { connector: `signals:${g.board}-gtm`, kind: 'hiring', value: `${g.postings.length} sales/GTM role${g.postings.length === 1 ? '' : 's'} posted, newest ${g.newest}`, label: g.postings.map(x => x.title).slice(0, 3).join('; ').slice(0, 200) || null, confidence: 70, source_url: g.url, source_date: g.newest, retrieved_at: now })
      passed++; continue
    }
    const line = heuristic
      ? `No sales-hiring evidence: a job board was found only through ${l.company_domain}, a domain matched by company name, so it is not established as this company's board. `
      : `No sales-hiring evidence: no sales or GTM posting dated in the last ${windowDays} days was found on a public job board tied to ${l.company_domain ?? 'a confirmed company domain (none found)'} (a board that could not be reached looks the same as none, so this is unconfirmed, not proof the company is not hiring). `
    if (demote.run(NO_SALES_HIRING, (line + (l.why ?? '')).trim().slice(0, WHY_MAX), l.id).changes) { counts.run(job.id); demoted++ }
  }
  audit(db, { tenantId: job.user_id, connector: 'scan:sales-hiring-gate', jobId: job.id, lookup: `${leads.length} leads, window ${windowDays}d`.slice(0, 200), status: demoted ? 'demoted' : 'ok', results: passed })
  return { required: true, checked: leads.length, passed, demoted }
}
