// Offer-specific demand rubric (issue #401). Deterministic: no model, no network. It answers three separate questions
// about one public post or thread, and never lets one stand in for another:
//   who is asking   the post's AUTHOR (from the source, never a company merely named in the text), screened first by
//                   lib/replies/requester.ts: a job seeker, recruiter, self-promoting vendor, consumer or announcement
//                   is not a buyer, whatever words it uses
//   what they show  which demand categories of the seller's rubric the text evidences, strong versus weak
//   how sure        three separate 0-3 scores: evidence (source, date, named author), fit (could this requester buy:
//                   a business asker, authority), intent (strength of the demand shown)
// A rubric is chosen from the tenant's own offer (rubricFor): the same rule for every tenant, no tenant-specific
// exception. Agencies and consultancies stay eligible when they ask for a buying use case; being in sales or marketing,
// or selling a sales tool, does not disqualify by itself, only self-promotion without an ask does.
// contact_permitted is always false here: a public post, a comparison request or an evaluation is not permission to
// contact anyone. Whether outreach may happen is decided by consent and the send safeguards, not by demand.
import { requesterRole, type RequesterRole } from '../replies/requester.ts'

export type DemandCategory = 'vendor_request' | 'data_quality' | 'workflow_bottleneck' | 'evaluation'
export interface DemandRubric {
  id: string; version: string
  // what the rubric is for: chosen when the seller's offer matches this
  offer: RegExp
  strong: Record<DemandCategory, RegExp>
  // contextual triggers: true, but not demand for this offer (funding, hiring SDRs, growing)
  weak: RegExp
}
const words = (xs: string[]) => new RegExp(`\\b(?:${xs.join('|')})\\b`, 'i')

export const LEAD_GENERATION: DemandRubric = {
  id: 'lead-generation', version: '1',
  offer: words(['leads?', 'lead (?:gen|generation|research|lists?)', 'prospect(?:s|ing)?', 'outbound', 'pipeline', 'b2b data', 'contact data', 'sales intelligence', 'find (?:customers|clients|buyers)']),
  strong: {
    // explicitly asking for a lead source, list, data provider or tool to find customers
    vendor_request: words([
      '(?:looking for|need|recommend(?:ations?)?(?: for)?|any(?:one)? (?:know|recommend)|suggest(?:ions?)?(?: for)?) (?:a |an |some |good )?(?:b2b )?(?:lead (?:gen|generation)?|leads?|lead source|lead list|prospect list|data provider|contact data|lead gen (?:tool|agency|service)|prospecting tool)',
      'where (?:do|can) (?:you|i|we) (?:find|get|buy) (?:b2b )?(?:leads|prospects|contacts)', 'best (?:tool|tools|way) (?:for|to) (?:find|get|generate) (?:b2b )?(?:leads|prospects|clients|customers)',
    ]),
    // complaints about list quality or the research burden
    data_quality: words([
      'bounce rate', 'bounced', 'outdated (?:contacts?|data|lists?)', 'bad (?:data|leads|lists?)', '(?:wrong|stale|old) (?:emails?|contacts?|data)',
      'lists? (?:are|is|were) (?:garbage|useless|terrible|bad)', 'hours (?:of|on) (?:research|prospecting|finding)', 'manual(?:ly)? (?:research|prospecting|finding)',
    ]),
    // an outbound workflow that is stuck
    workflow_bottleneck: words([
      "can'?t (?:find|get) (?:enough )?(?:leads|prospects|clients|customers)", 'struggling (?:to|with) (?:find|get|generate|book) (?:leads|prospects|clients|customers|meetings)',
      'no (?:pipeline|leads)', 'pipeline is (?:empty|dry|thin)', 'outbound (?:is|isn.t) (?:not )?working', 'cold (?:email|outreach) (?:is|isn.t) (?:not )?working',
      'how (?:do|can|should) (?:i|we) (?:find|get|land|win) (?:our |my )?(?:first |more |new )?(?:clients|customers|leads)',
      // deliverability: the outbound program is not reaching anyone
      'spam filters?', 'deliverability', '(?:landing|going|ending up) in (?:the )?spam', 'dead on arrival', '(?:reply|open) rates? (?:dropped|is low|are low|tanked)',
    ]),
    // evaluating or switching tools
    evaluation: words(['alternatives? to', 'switch(?:ing)? (?:from|away from)', 'replac(?:e|ing) (?:apollo|zoominfo|lusha|clay|seamless|our (?:lead|data) (?:tool|provider))', '(?:vs\\.?|versus|compared to) (?:apollo|zoominfo|lusha|clay|seamless)', 'which (?:is better|one should i (?:use|pick))']),
  },
  weak: words(['raised', 'funding', 'series [a-e]', 'seed round', 'hiring (?:an? )?(?:sdrs?|bdrs?|sales (?:reps?|team|people))', 'growing (?:fast|quickly|the team)', 'scaling', 'expanding', 'new office']),
}
// Rubrics a tenant's offer can select. More are added here (one per kind of offer), never per tenant.
export const RUBRICS: DemandRubric[] = [LEAD_GENERATION]
export function rubricFor(offer: string): DemandRubric | null {
  return RUBRICS.find(r => r.offer.test(offer)) ?? null
}

const AUTHORITY = words(['founder', 'co-?founder', 'ceo', 'owner', 'managing director', 'president', 'head of (?:sales|growth|marketing|revenue)', 'vp (?:of )?(?:sales|growth|marketing)', 'cro', 'director of sales', 'partner'])
const PRACTITIONER = words(['sdr', 'bdr', 'account executive', 'sales rep', 'growth marketer', 'marketer'])
const BUSINESS_ASKER = /\b(?:my|our) (?:company|startup|agency|business|firm|consultancy|saas|clients?|team|product|service)\b|\bwe (?:sell|offer|run|are an?)\b|\bi run\b/i

export interface DemandInput { title: string; quote: string; source_url?: string | null; date?: string | null; author?: { name?: string | null; headline?: string | null } | null }
export interface DemandAssessment {
  rubric: string | null
  requester: { role: RequesterRole | null; name: string | null; authority: 'decision_maker' | 'practitioner' | 'unknown'; business_asker: boolean }
  categories: DemandCategory[]; weak_triggers: boolean
  scores: { evidence: number; fit: number; intent: number }
  verdict: 'high_intent' | 'possible' | 'not_demand'
  // filter before paid grading: a requester who is not a buyer, or only a contextual trigger and no demand at all.
  // A post the rubric simply does not recognise is not filtered: it still goes to grading.
  screen_out: boolean
  contact_permitted: false
  reasons: string[]
}

export function assessDemand(i: DemandInput, rubric: DemandRubric | null): DemandAssessment {
  const text = `${i.title}\n${i.quote}`.replace(/\s+/g, ' ')
  const role = requesterRole(i.title, i.quote)
  const name = i.author?.name?.trim() || null
  const headline = i.author?.headline ?? ''
  const authority = AUTHORITY.test(headline) || /\bi(?:'m| am) (?:the |a )?(?:co-?)?founder\b|\bi (?:own|run) (?:a|an|my)\b/i.test(text) ? 'decision_maker' : PRACTITIONER.test(headline) ? 'practitioner' : 'unknown'
  const businessAsker = BUSINESS_ASKER.test(text) || authority !== 'unknown'
  const categories = rubric ? (Object.keys(rubric.strong) as DemandCategory[]).filter(c => rubric.strong[c].test(text)) : []
  const weak = !!rubric && rubric.weak.test(text)
  const reasons: string[] = []
  const evidence = (i.source_url ? 1 : 0) + (i.date ? 1 : 0) + (name ? 1 : 0)
  if (!i.source_url) reasons.push('no source link'); if (!i.date) reasons.push('undated'); if (!name) reasons.push('author not named')
  const fit = role ? 0 : (businessAsker ? 1 : 0) + (authority === 'decision_maker' ? 2 : authority === 'practitioner' ? 1 : 0)
  if (role) reasons.push(`requester is not a buyer: ${role}`)
  else if (!businessAsker) reasons.push('not shown to be asking for a business')
  const intent = role ? 0 : categories.some(c => c === 'vendor_request' || c === 'evaluation') ? 3 : categories.length ? 2 : weak ? 1 : 0
  if (!rubric) reasons.push('no demand rubric for this offer')
  else if (!categories.length) reasons.push(weak ? 'only a contextual trigger (funding, hiring, growth): not demand for this offer' : 'no demand for this offer shown')
  const verdict = role || intent <= 1 ? 'not_demand' : intent >= 2 && Math.min(fit, 3) >= 2 && evidence >= 2 ? 'high_intent' : 'possible'
  return {
    rubric: rubric ? `${rubric.id}@${rubric.version}` : null,
    requester: { role, name, authority, business_asker: businessAsker },
    categories, weak_triggers: weak,
    scores: { evidence, fit: Math.min(fit, 3), intent },
    verdict, screen_out: !!role || (categories.length === 0 && weak), contact_permitted: false, reasons,
  }
}
