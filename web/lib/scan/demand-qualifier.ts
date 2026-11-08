// Offer-specific demand qualification (#401). Separates a real buyer of the play's offer from the posts that only
// look like one: a vendor promoting its own product, a saved competitor, a job seeker, a recruiter filling a role, a
// consumer asking for a local/personal service, a third party's need reported by someone else, an unrelated event
// (a funding or launch announcement) and generic growth chatter.
//
// Pure and deterministic: no model call, no fetch, no clock (as_of is passed in). The rubric is built from what every
// tenant already configures for a play - the play's effective offer (play-offer.ts) and the tenant's saved competitors
// (signals/competitor-reddit.ts) - so a tenant selling bookkeeping gets the same mechanism as a tenant selling leads.
// There is no seller-specific branch.
//
// Evidence-bound: every reason quotes a sentence that appears verbatim in the post, and the result carries the source
// URL, the post date and the requester (the post's author as the source reports it, never a company the post merely
// mentions). Evidence, fit and intent are scored separately. Fail closed: no offer, no requester, no date, a date
// outside the window or in the future, or a source that is not http(s) can never be high intent. Qualification never
// grants permission to contact anyone (a comparison request included); consent and send gates decide that elsewhere.
import { norm } from './evidence.ts'
import type { PlayOffer } from './play-offer-text.ts'

export const DEMAND_QUALIFIER_VERSION = 'demand-qualifier/1'
export const DEFAULT_WINDOW_DAYS = 90
const QUOTE_MAX = 280
const DAY_MS = 86_400_000

export type DemandClass =
  | 'buyer'               // the requester states their own need for what the offer provides
  | 'competitor'          // the requester works for a saved competitor or for the seller itself
  | 'vendor_promotion'    // the requester promotes their own product or service
  | 'job_seeker'          // the requester is looking for a job, internship or clients for themselves as a candidate
  | 'recruiter'           // the requester is filling a role (hiring a sales rep is a weak trigger, not demand)
  | 'consumer'            // a personal/local service request with no business context
  | 'third_party_demand'  // the need belongs to someone the requester mentions (a client, a friend), not the requester
  | 'unrelated_event'     // a funding round, launch or other announcement with no stated need
  | 'generic_growth'      // growth/marketing chatter that never states a need for this offer
  | 'unclear'             // nothing above is shown

export type DemandFamily = 'vendor_request' | 'list_quality' | 'workflow_bottleneck' | 'evaluation_switching'
export type Authority = 'decision_maker' | 'influencer' | 'none' | 'unknown'
export type Tier = 'high_intent' | 'needs_evidence' | 'weak_trigger' | 'excluded' | 'unqualifiable'

export interface DemandRubric {
  version: string
  offer: string
  need_terms: string[]     // stemmed phrases a stated need must name (derived from the offer)
  competitors: string[]    // the tenant's saved competitors
  own_names: string[]      // the seller's own brand names (a post by the seller is never a lead)
  window_days: number
}
export interface DemandPost {
  source_url: string
  published_at: string | null          // as the source dates the post; null when it does not
  author: { name: string | null; headline?: string | null; company?: string | null; url?: string | null } | null
  title?: string | null
  text: string
}
export interface Quote { rule: string; quote: string }
export interface DemandResult {
  version: string
  class: DemandClass
  tier: Tier
  families: DemandFamily[]
  scores: { evidence: number; fit: number; intent: number } // each 0-3, never summed
  requester: { name: string | null; company: string | null; headline: string | null; authority: Authority; business_shown: boolean }
  mentioned_orgs: string[]             // companies the post names that are NOT the requester (a client, a competitor...)
  source: { url: string; published_at: string | null; age_days: number | null }
  reasons: Quote[]                     // verbatim sentences from the post, one per rule that fired
  missing: string[]                    // why a buyer is not high intent (empty when it is)
  contact: { permitted: false; note: string }
}

// ---------------------------------------------------------------------------------------------------- rubric
const STOP = new Set(('a an and or the of for to in on at by with from into our your their my we you they it its is are be ' +
  'that this these those who what which as than then so but not no all any each per via up out over about more most').split(' '))
// Broad words that name a context, not a need: a post saying "sales" or "growth" has not asked for the offer.
const GENERIC = new Set(('b2b b2c saas business businesses company companies team teams startup startups customer customers client clients ' +
  'sales marketing growth revenue tool tools software platform platforms service services solution solutions app product products ' +
  'help helps find finds finding build builds get gets make makes run runs use uses automate automates qualify qualifies deliver delivers ' +
  'provide provides offer offers new best fast easy simple monthly weekly daily small large independent local online digital generation management').split(' '))
// Light stemmer used on both sides of every need-term match, so "leads"/"lead", "bookkeeper"/"bookkeeping" agree.
export function stem(w: string): string {
  let s = w.toLowerCase()
  if (s.length > 4 && s.endsWith('ies')) s = `${s.slice(0, -3)}y`
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1)
  for (const suf of ['ing', 'ers', 'er']) if (s.length - suf.length >= 4 && s.endsWith(suf)) { s = s.slice(0, -suf.length); break }
  return s
}
const words = (s: string): string[] => norm(s.replace(/-/g, ' ')).split(' ').filter(Boolean)
const stemmed = (s: string): string => words(s).map(stem).join(' ')

export function needTermsFromOffer(offer: string, ownNames: string[] = []): string[] {
  const own = new Set(ownNames.flatMap(n => words(n)))
  const ws = words(offer).filter(w => !own.has(w))
  const terms = new Set<string>()
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]
    if (!STOP.has(w) && !GENERIC.has(w) && w.length >= 4) terms.add(stem(w))
    const n = ws[i + 1]
    if (n && !STOP.has(w) && !STOP.has(n) && !(GENERIC.has(w) && GENERIC.has(n))) terms.add(`${stem(w)} ${stem(n)}`)
  }
  return [...terms].sort()
}

export interface RubricInput { offer: string | null; competitors?: string[]; own_names?: string[]; window_days?: number }
// null: no offer to qualify against (fail closed: every post becomes unqualifiable).
export function demandRubric(input: RubricInput): DemandRubric | null {
  const offer = (input.offer ?? '').replace(/\s+/g, ' ').trim()
  if (!offer) return null
  const own_names = (input.own_names ?? []).map(s => s.trim()).filter(s => s.length >= 2)
  const need_terms = needTermsFromOffer(offer, own_names)
  if (need_terms.length === 0) return null
  return {
    version: DEMAND_QUALIFIER_VERSION, offer, need_terms, own_names,
    competitors: (input.competitors ?? []).map(s => s.trim()).filter(s => s.length >= 2),
    window_days: input.window_days && input.window_days > 0 ? input.window_days : DEFAULT_WINDOW_DAYS,
  }
}

// The rubric of one play from what the tenant configured: the play's effective offer and the saved competitors. A play
// whose offer is in conflict or missing has no rubric (play-offer.ts refuses drafting for it for the same reason).
export function rubricForPlay(offer: PlayOffer | null, competitors: string[], ownNames: string[] = [], windowDays?: number): { rubric: DemandRubric | null; reason: string | null } {
  if (!offer) return { rubric: null, reason: 'no_such_play' }
  if (offer.offer === null) return { rubric: null, reason: offer.source === 'conflict' ? 'offer_conflict' : 'no_offer' }
  const rubric = demandRubric({ offer: offer.offer, competitors, own_names: ownNames, window_days: windowDays })
  return { rubric, reason: rubric ? null : 'offer_has_no_need_terms' }
}

// ---------------------------------------------------------------------------------------------------- cues
const FIRST = /\b(?:i|i'm|im|i've|i'd|we|we're|we've|we'd|our|my|us|me)\b/i
const SEEK = /\b(?:looking for|look for|searching for|in the market for|need(?:s|ed)?|want(?:s|ed)? (?:a|an|to (?:buy|find|get))|recommend(?:ation)?s?|suggestions?|any(?:one| one)? (?:know|use|tried|recommend)|who (?:do you|does|can) (?:use|provide|recommend)|where (?:can|do) (?:i|we) (?:get|find|buy)|what (?:do you|are you) (?:use|using)|best (?:\w+ )?(?:for|to)|willing to pay|budget for|hire an? (?:vendor|agency|provider|service))\b/i
const LIST_QUALITY = /\b(?:bounc\w*|outdated|out of date|stale|inaccurate|wrong|bad|garbage|junk|useless|low[- ]quality|dead|invalid|unverified|duplicat\w*|half of (?:the|them)|(?:\d{1,3}) ?% (?:bounce|wrong|invalid|dead))\b/i
const BOTTLENECK = /\b(?:spend(?:s|ing)? (?:hours|days|half|all|too much)|manual(?:ly)?|by hand|can'?t keep up|bottleneck|takes? (?:forever|hours|days)|struggl\w+|stuck|burn(?:ing)? (?:hours|time)|waste (?:of time|hours)|drowning)\b/i
const SWITCH = /\b(?:alternatives? (?:to|for)|switch(?:ing|ed)? (?:from|away|off)|moving (?:off|away from)|replac\w+|cancel\w*|compar\w+|vs\.?|versus|evaluat\w+|shortlist\w*|trial(?:ing|ed)?)\b/i
// Promotion of the requester's own offer. STRONG cues are promotion whatever else the post says.
const PROMO_STRONG = /\b(?:check out (?:our|my)|dm me|dm us|pm me|link in (?:bio|comments?)|book a (?:call|demo) with (?:me|us)|(?:start|get) (?:a|your) free trial|we (?:just )?(?:built|launched|shipped)|i (?:just )?(?:built|launched|made)|use (?:my|our) code|shameless plug|(?:our|my) (?:tool|platform|product|app|software|startup) (?:helps|lets|finds|gives|delivers|generates|books|builds))\b/i
const PROMO_WEAK = /\b(?:we|i) (?:help|generate|deliver|provide|offer|book|sell|build)\b/i
const JOB_SEEK = /\b(?:internships?|intern\b|open to work|hire me|my (?:resume|cv|portfolio)|entry[- ]level|new grad|fresh(?:er| graduate)|(?:i'm|i am) a (?:student|graduate|recent grad)|(?:looking for|seeking|applying (?:for|to)) (?:an? )?(?:job|role|position|internship|full[- ]time|part[- ]time|remote (?:job|role|position))s?\b|(?:my next|a new) (?:role|job|position|opportunity)|job hunt\w*|job search\w*)/i
const ROLE = String.raw`(?:sdr|bdr|ae|account executive|sales (?:rep|representative|development rep\w*|manager)|recruiter|marketer|intern|developer|engineer|designer|bookkeeper|accountant|\w+ (?:manager|specialist|associate|coordinator))`
const RECRUIT = new RegExp(String.raw`\b(?:we(?:'re| are) hiring|now hiring|is hiring|job (?:opening|posting|ad)s?|open (?:role|position)s?|apply (?:now|here|today|via|at)|join our team|send (?:me |us )?your (?:cv|resume)|candidates?|(?:hiring|recruiting) (?:an? |our |for )?(?:first |next |experienced |senior |junior )?${ROLE}|(?:looking for|need|seeking) (?:an? |our )(?:first |next |experienced |senior |junior |full[- ]time |part[- ]time )?${ROLE}s?\b)`, 'i')
const CONSUMER = /\b(?:near me|in my (?:area|neighbou?rhood|town|city|building)|for my (?:house|home|apartment|flat|wedding|family|kids?|son|daughter|dog|cat|car|mom|mum|dad|parents|birthday|garden|bathroom|kitchen)|my (?:kitchen|bathroom|landlord|apartment|house|taxes|tax return|move|renovation)|as a (?:homeowner|tenant|renter|parent))\b/i
const BUSINESS = /\b(?:(?:my|our) (?:company|business|startup|agency|consultancy|firm|practice|clinic|restaurant|store|shop|studio|saas|team|clients?|customers?)|(?:i|we) (?:run|own|founded|co-?founded|started)|(?:i'm|i am|as) (?:the |a )?(?:co-?founder|founder|ceo|owner|head of \w+|vp of \w+|managing director)|we(?:'re| are) an? (?:\S+ ){0,3}(?:company|business|startup|agency|consultancy|firm|saas|practice|restaurant|shop|studio)|\bb2b\b)/i
const EVENT = /\b(?:raised|closes?d? (?:a|our) \$?\d|seed round|pre-?seed|series [a-e]\b|funding round|backed by|announc\w+|(?:just|proud to|excited to) (?:launch|announce|share)|acquired|acquisition|ipo)\b/i
const GROWTH = /\b(?:grow\w*|growth|scale|scaling|traction|marketing|go[- ]to[- ]market|gtm|founder tips|tips?|lessons?|advice|hacks?|playbook|revenue)\b/i
// A need stated for someone else: "our client Acme is looking for...", "my friend's company needs...".
const THIRD = /\b(?:(?:my|our|a) (?:friend|client|customer|boss|cousin|colleague|partner|portfolio company|buddy)(?:'s)?|(?:a|one) (?:client|customer|friend) of (?:ours|mine)|(?:he|she|they) (?:is|are|need|needs|want|wants))\b/i
const DECISION = /\b(?:co-?founder|founder|ceo|cro|coo|owner|president|managing (?:director|partner)|partner|principal|head of (?:sales|growth|revenue|marketing|business development|bd)|vp(?: of)? (?:sales|growth|revenue|marketing)|chief \w+ officer|director of (?:sales|growth|revenue|marketing))\b/i
const INFLUENCER = /\b(?:sdr|bdr|account executive|\bae\b|sales (?:rep|manager|lead|ops)|revops|growth (?:lead|marketer|manager)|marketer|marketing manager|demand gen\w*|business development (?:rep|manager))\b/i
const NO_AUTHORITY = /\b(?:student|intern|job seeker|looking for work|open to work|unemployed|recent grad|new grad)\b/i

const IMPLIED_FIRST = /^(?:looking for|searching for|seeking|need(?:ing)?|in the market for|any (?:recommendations|suggestions))\b/i

// Sentences of the ORIGINAL text, so a quote is always a verbatim substring of the post.
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean)
}
const clip = (s: string) => s.length <= QUOTE_MAX ? s : s.slice(0, QUOTE_MAX)
function namesTerm(sentence: string, terms: string[]): boolean {
  const hay = ` ${stemmed(sentence)} `
  return terms.some(t => hay.includes(` ${t} `))
}
function mentions(text: string, name: string): boolean {
  const n = norm(name)
  return !!n && ` ${norm(text)} `.includes(` ${n} `)
}
// Capitalised names after a third-party or customer phrase ("our client Acme Corp") - recorded, never the requester.
function mentionedOrgs(text: string, rubric: DemandRubric): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\b(?:client|customer|friend's company|portfolio company|competitor)s?,? ([A-Z][\w&.-]*(?: [A-Z][\w&.-]*){0,2})/g)) out.add(m[1])
  for (const c of rubric.competitors) if (mentions(text, c)) out.add(c)
  return [...out].sort()
}

function authorityOf(headline: string, selfText: string): Authority {
  const s = `${headline} ${selfText}`
  if (NO_AUTHORITY.test(s)) return 'none'
  if (DECISION.test(s)) return 'decision_maker'
  if (INFLUENCER.test(s)) return 'influencer'
  return 'unknown'
}

// ---------------------------------------------------------------------------------------------------- qualify
export function qualifyDemand(post: DemandPost, rubric: DemandRubric | null, asOf: Date): DemandResult {
  const text = `${post.title ? `${post.title}\n` : ''}${post.text ?? ''}`
  const sentences = sentencesOf(text)
  const reasons: Quote[] = []
  const cite = (rule: string, s: string) => { if (!reasons.some(r => r.rule === rule)) reasons.push({ rule, quote: clip(s) }) }
  const first = (re: RegExp, pred: (s: string) => boolean = () => true) => sentences.find(s => re.test(s) && pred(s)) ?? null

  const name = post.author?.name?.trim() || null
  const company = post.author?.company?.trim() || null
  const headline = post.author?.headline?.trim() || null
  const selfSentences = sentences.filter(s => FIRST.test(s) && (BUSINESS.test(s) || DECISION.test(s) || NO_AUTHORITY.test(s) || INFLUENCER.test(s)))
  const authority = authorityOf(headline ?? '', selfSentences.join(' '))
  const businessSentence = first(BUSINESS, s => FIRST.test(s) || /\bb2b\b/i.test(s))
  const business_shown = !!businessSentence || (!!company && !!headline && !NO_AUTHORITY.test(headline))
  if (businessSentence) cite('business_shown', businessSentence)

  // source and date (evidence)
  let urlOk = false
  try { urlOk = /^https?:$/.test(new URL(post.source_url).protocol) } catch { urlOk = false }
  const t = post.published_at ? Date.parse(post.published_at) : NaN
  const age_days = Number.isFinite(t) ? Math.floor((asOf.getTime() - t) / DAY_MS) : null
  const missing: string[] = []
  if (!urlOk) missing.push('source_url_not_http')
  if (age_days === null) missing.push('date_unknown')
  else if (age_days < 0) missing.push('date_in_future')
  else if (rubric && age_days > rubric.window_days) missing.push('date_outside_window')
  if (!name) missing.push('requester_unknown')
  const dateOk = age_days !== null && age_days >= 0 && (!rubric || age_days <= rubric.window_days)
  const evidence = (urlOk ? 1 : 0) + (dateOk ? 1 : 0) + (name ? 1 : 0)

  const base = {
    version: DEMAND_QUALIFIER_VERSION,
    requester: { name, company, headline, authority, business_shown },
    mentioned_orgs: rubric ? mentionedOrgs(text, rubric) : [],
    source: { url: post.source_url, published_at: post.published_at, age_days },
  }
  const fit = (authority === 'decision_maker' ? 2 : authority === 'influencer' ? 1 : 0) + (business_shown ? 1 : 0)
  const done = (cls: DemandClass, tier: Tier, families: DemandFamily[], intent: number, note = 'Qualification never grants permission to contact; consent and send gates decide.'): DemandResult =>
    ({ ...base, class: cls, tier, families, scores: { evidence, fit: cls === 'consumer' || cls === 'job_seeker' ? 0 : fit, intent }, reasons, missing: tier === 'high_intent' ? [] : missing, contact: { permitted: false, note } })

  if (!rubric) { missing.unshift('no_offer_rubric'); return done('unclear', 'unqualifiable', [], 0) }
  const terms = rubric.need_terms

  // 1. the seller itself or a saved competitor (by the requester's own identity, not a mention in the text)
  const who = `${company ?? ''} ${headline ?? ''}`
  const rival = [...rubric.own_names.map(n => ['own_seller', n] as const), ...rubric.competitors.map(n => ['saved_competitor', n] as const)].find(([, n]) => mentions(who, n))
  if (rival) { reasons.push({ rule: rival[0], quote: clip(who.trim()) }); missing.push(rival[0]); return done('competitor', 'excluded', [], 0) }

  // demand families: a sentence that names the offer's need AND states it as the requester's own
  // The requester's own need: first person, a question, or a fragment that starts with the seeking verb ("Looking for a ...").
  const own = (s: string) => FIRST.test(s) || /\?\s*$/.test(s) || IMPLIED_FIRST.test(s)
  const fam = (re: RegExp) => first(re, s => namesTerm(s, terms) && own(s))
  const hits: [DemandFamily, string | null, number][] = [
    ['vendor_request', fam(SEEK), 3],
    ['evaluation_switching', first(SWITCH, s => (namesTerm(s, terms) || rubric.competitors.some(c => mentions(s, c))) && own(s)), 3],
    ['list_quality', fam(LIST_QUALITY), 2],
    ['workflow_bottleneck', fam(BOTTLENECK), 2],
  ]
  const families = hits.filter(h => h[1]).map(h => h[0])
  const demandIntent = Math.max(0, ...hits.filter(h => h[1]).map(h => h[2]))

  // 2. exclusions that hold whatever need the post names (a job seeker's "DM me" is still a job seeker)
  const jobSeek = first(JOB_SEEK)
  if (jobSeek) { cite('seeks_job', jobSeek); missing.push('seeks_job'); return done('job_seeker', 'excluded', [], 0) }
  const promoStrong = first(PROMO_STRONG)
  if (promoStrong) { cite('promotes_own_offer', promoStrong); missing.push('promotes_own_offer'); return done('vendor_promotion', 'excluded', [], 0) }
  const recruit = first(RECRUIT)
  if (recruit) { cite('fills_role', recruit); missing.push('fills_role_weak_trigger'); return done('recruiter', 'weak_trigger', [], 1) }
  const consumer = first(CONSUMER)
  if (consumer && !business_shown) { cite('personal_request', consumer); missing.push('personal_request'); return done('consumer', 'excluded', [], 0) }
  // A self-description ("we help SaaS teams with outbound") is promotion only when the post states no need of its own:
  // an agency asking for a lead source stays eligible.
  // ...and a hook question ("Need more leads? We deliver ...") is the vendor's, not a need: no demand sentence is first person.
  const promoWeak = first(PROMO_WEAK, s => namesTerm(s, terms))
  const demandSentences = hits.map(h => h[1]).filter((s): s is string => !!s)
  if (promoWeak && (families.length === 0 || !demandSentences.some(s => FIRST.test(s)))) { cite('promotes_own_offer', promoWeak); missing.push('promotes_own_offer'); return done('vendor_promotion', 'excluded', [], 0) }

  // 3. a need that belongs to someone else
  const third = demandSentences.find(s => THIRD.test(s))
  if (families.length && third && demandSentences.every(s => THIRD.test(s))) {
    cite('third_party_need', third); missing.push('need_is_third_party')
    return done('third_party_demand', 'excluded', families, 0)
  }

  // 4. a stated need for the offer
  if (families.length) {
    for (const [f, s] of hits) if (s) cite(f, s)
    const comparison = families.includes('evaluation_switching')
    const note = comparison
      ? 'A comparison or switching request is not permission to contact; consent and send gates decide.'
      : 'Qualification never grants permission to contact; consent and send gates decide.'
    // High intent needs the requester's own authority to buy, not only a stated need: an SDR asking stays reviewable.
    if (authority !== 'decision_maker') missing.push(authority === 'unknown' ? 'authority_unknown' : 'authority_insufficient')
    if (!business_shown) missing.push('business_not_shown')
    const high = demandIntent >= 2 && authority === 'decision_maker' && business_shown && evidence === 3
    return done('buyer', high ? 'high_intent' : 'needs_evidence', families, demandIntent, note)
  }

  // 5. no need stated: contextual triggers only
  const event = first(EVENT)
  if (event) { cite('event_only', event); missing.push('no_stated_need'); return done('unrelated_event', 'weak_trigger', [], 1) }
  const growth = first(GROWTH)
  if (growth) { cite('growth_chatter', growth); missing.push('no_stated_need'); return done('generic_growth', 'weak_trigger', [], 0) }
  missing.push('no_stated_need')
  return done('unclear', 'excluded', [], 0)
}

// Precision of high intent and per-class agreement over labelled fixtures (synthetic; used by the test and any replay).
export interface Labelled { id: string; label: DemandClass; high_intent: boolean; result: DemandResult }
export function precisionReport(rows: Labelled[]) {
  const predictedHigh = rows.filter(r => r.result.tier === 'high_intent')
  const trueHigh = predictedHigh.filter(r => r.high_intent)
  const classes = [...new Set(rows.flatMap(r => [r.label, r.result.class]))].sort()
  const per_class = Object.fromEntries(classes.map(c => {
    const predicted = rows.filter(r => r.result.class === c), actual = rows.filter(r => r.label === c)
    const tp = predicted.filter(r => r.label === c).length
    return [c, { predicted: predicted.length, actual: actual.length, tp, precision: predicted.length ? tp / predicted.length : null, recall: actual.length ? tp / actual.length : null }]
  }))
  return {
    total: rows.length,
    high_intent: { predicted: predictedHigh.length, correct: trueHigh.length, expected: rows.filter(r => r.high_intent).length, precision: predictedHigh.length ? trueHigh.length / predictedHigh.length : null },
    class_accuracy: rows.filter(r => r.label === r.result.class).length / Math.max(1, rows.length),
    per_class,
    confusions: rows.filter(r => r.label !== r.result.class).map(r => ({ id: r.id, label: r.label, got: r.result.class })),
  }
}
