// Sales claims and prospect qualification against the product truth record (#402, lib/product-truth.ts).
//
// truthClaimIssues: what a draft (or any outbound copy) says about the product, checked against what is shipped:
//   capability_unavailable:<id>    names a channel, integration, model or feature the record lists as not shipped
//   capability_limited:<id>        names one that works only with a prerequisite the copy does not disclose (an own
//                                  provider key) or that needs an operator worker dazl does not run
//   price_not_in_truth             states a price that is not a published plan price
//   byok_not_disclosed             talks price or plans without saying it runs on the buyer's own AI key and that the
//                                  provider bills that usage separately
//   comparative_unbenchmarked:<c>  compares with competitor <c> without linking a published benchmark of <c> that the
//                                  owner's policy also lists
//   unbacked_superlative           "the best", "#1", "guaranteed results", "10x more" with no benchmark at all
//   product_truth_changed          the copy relies on product truth, and the record changed since the owner accepted it
// A negated mention ("there is no LinkedIn messaging") is a disclosed limitation, not a promise. Quoted text and links
// are the lead's own source words, not the seller's claims, and are not read as claims.
//
// qualifyProspect: a prospect who states they need a capability the record does not ship is no_fit (unavailable) or
// waitlist (limited), never pitched by automation. Bounded on purpose: a need-phrase list, not a parser; job-ad
// requirement language ("experience with Salesforce") is not the buyer's requirement of dazl.
import type { Capability, ProductTruth } from '../product-truth.ts'
import type { ProductFacts } from '../replies/buyer-answers.ts'

const QUOTED = /"[^"\n]*"|“[^”\n]*”|https?:\/\/[^\s)>"']+/g
const NEGATION = /\b(?:no|not|never|without|don'?t|doesn'?t|isn'?t|aren'?t|cannot|can'?t|won'?t|nor|neither)\b/i
const OWN_KEY = /\b(?:your|their|the buyer'?s) own (?:ai |api |model |provider |openai |anthropic |apollo |pdl )?(?:key|api key)s?\b|\bbring your own (?:ai |api )?key\b|\bbyok\b/i
const PROVIDER_COST = /\b(?:provider|openai|anthropic)\b[^.\n]{0,60}\b(?:bills?|charges?|invoices?|costs?|pay)\b|\b(?:billed|charged|paid) separately\b|\bseparate (?:provider )?(?:bill|cost|charge)s?\b/i
const PRICE_AMOUNT = /(?:[$€£]\s?(\d[\d,]*(?:\.\d+)?))|(?:\b(\d[\d,]*(?:\.\d+)?)\s?(?:usd|dollars|eur|gbp)\b)/gi
const PRICE_TALK = /\b(?:pricing|prices?|priced|per month|\/mo\b|monthly fee|subscription|(?:free|pro|paid) plan|plans? (?:start|cost))\b/i
const COMPARE = /\b(?:better|best|faster|cheaper|more (?:accurate|leads|qualified|replies|meetings)|outperform\w*|beats?|beating|superior|ahead of|vs\.?|versus|than|instead of|replaces?|alternative to)\b/i
const SUPERLATIVE = /\b(?:the best|#1|number one|guarantee[sd]? (?:leads|meetings|results|replies)|guaranteed|\d+x (?:more|better|faster))\b/i
const NEED = /\b(?:we|our team|i|our company)(?:'re| are| am)?\s+(?:\w+\s+){0,2}?(?:need|needs|require|requires|want|are looking for|looking for|must have|rely on|have to have)\b|\b(?:must|has to|needs to|have to) (?:integrate|work|sync|support|connect|send)\b|\b(?:requirement|requirements|a must|must-have|non-negotiable|deal-?breaker)\b/i
const JOB_LANGUAGE = /\b(?:experience|experienced|familiar\w*|proficien\w*|knowledge of|skills?|years? of|candidates?|you will|you'll|responsibilit\w*|hiring|role|position|apply)\b/i

const sentences = (text: string) => text.replace(QUOTED, ' ').split(/[.!?;]+(?=\s|$)|\n+/).map(s => s.trim()).filter(Boolean)
const aliasRes = new WeakMap<Capability, RegExp[]>()
const res = (c: Capability) => {
  let r = aliasRes.get(c)
  if (!r) { r = c.aliases.map(a => new RegExp(`(?<![\\w.-])(?:${a})(?![\\w-])`, 'i')); aliasRes.set(c, r) }
  return r
}
// Capabilities a sentence names without negating them first.
function named(sentence: string, truth: ProductTruth): Capability[] {
  const out: Capability[] = []
  for (const c of truth.capabilities) {
    for (const re of res(c)) {
      const m = re.exec(sentence)
      if (m && !NEGATION.test(sentence.slice(0, m.index))) { out.push(c); break }
    }
  }
  return out
}
const competitorRe = (c: string) => new RegExp(`(?<![\\w.-])${c}(?![\\w-])`, 'i')

export interface ClaimOptions {
  benchmarkUrls?: string[]                  // the benchmark links the owner's policy allows (launch-policy claims)
  acceptedVersion?: string | null           // the product truth version the owner accepted; null: no binding check
}

export function truthClaimIssues(text: string, truth: ProductTruth, o: ClaimOptions = {}): string[] {
  const issues = new Set<string>()
  let reliesOnTruth = false
  const links: string[] = text.match(/https?:\/\/[^\s)>"']+/gi) ?? []
  const allowedBench = new Set(o.benchmarkUrls ?? [])
  const disclosedKey = OWN_KEY.test(text)
  for (const s of sentences(text)) {
    for (const c of named(s, truth)) {
      reliesOnTruth = true
      if (c.state === 'unavailable') issues.add(`capability_unavailable:${c.id}`)
      else if (c.state === 'limited' && !(c.requires.every(r => r === 'own_key') && disclosedKey)) issues.add(`capability_limited:${c.id}`)
    }
    if (COMPARE.test(s)) {
      for (const comp of truth.competitors) {
        if (!competitorRe(comp).test(s)) continue
        reliesOnTruth = true
        const backed = truth.benchmarks.some(b => b.competitors.includes(comp) && allowedBench.has(b.url) && links.includes(b.url))
        if (!backed) issues.add(`comparative_unbenchmarked:${comp}`)
      }
    }
    if (SUPERLATIVE.test(s)) {
      reliesOnTruth = true
      const backed = truth.benchmarks.some(b => allowedBench.has(b.url) && links.includes(b.url))
      if (!backed) issues.add('unbacked_superlative')
    }
  }
  const scan = text.replace(QUOTED, ' ')
  const prices = [...scan.matchAll(PRICE_AMOUNT)].map(m => Number((m[1] ?? m[2]).replace(/,/g, '')))
  if (prices.length || PRICE_TALK.test(scan)) {
    reliesOnTruth = true
    const published = new Set(truth.pricing.plans.map(p => p.monthlyUsd))
    if (prices.some(p => !published.has(p))) issues.add('price_not_in_truth')
    if (!(disclosedKey && PROVIDER_COST.test(scan))) issues.add('byok_not_disclosed')
  }
  if (o.acceptedVersion && o.acceptedVersion !== truth.version && reliesOnTruth) issues.add('product_truth_changed')
  return [...issues]
}

export type Qualification = { verdict: 'fit' | 'waitlist' | 'no_fit'; unmet: string[] }
// What the prospect says they need, against the record. Only need statements count; a mention is not a requirement.
export function qualifyProspect(text: string, truth: ProductTruth): Qualification {
  const unmet = new Map<string, Capability>()
  for (const s of sentences(text)) {
    if (!NEED.test(s) || JOB_LANGUAGE.test(s)) continue
    for (const c of named(s, truth)) if (c.state !== 'available') unmet.set(c.id, c)
  }
  const all = [...unmet.values()]
  const verdict = all.some(c => c.state === 'unavailable') ? 'no_fit' : all.length ? 'waitlist' : 'fit'
  return { verdict, unmet: all.map(c => c.id) }
}

const list = (xs: string[]) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`
const usd = (n: number) => `$${n}`
// The routine buyer answers' facts (lib/replies/buyer-answers.ts), built from the record alone, stamped with its version:
// pricing, prerequisites, limits and the integrations an answer may confirm are exactly what the record ships.
export function productFactsFromTruth(truth: ProductTruth, urls: { signupUrl: string; bookingUrl: string | null }): ProductFacts {
  const avail = (k: Capability['kind']) => truth.capabilities.filter(c => c.kind === k && c.state === 'available')
  const models = avail('model').map(c => c.id.split(':')[1]).map(v => v === 'openai' ? 'OpenAI' : v === 'anthropic' ? 'Anthropic' : v)
  const senders = avail('channel').map(c => c.name)
  const notShipped = truth.capabilities.filter(c => c.kind === 'channel' && c.state === 'unavailable').map(c => c.name)
  const plans = truth.pricing.plans.map(p => `${p.id[0].toUpperCase()}${p.id.slice(1)} is ${usd(p.monthlyUsd)} a month (${p.scansPerMonth === null ? 'unlimited scans' : `${p.scansPerMonth} scans a month`})`)
  return {
    version: truth.version,
    pricing: `${plans.join('. ')}. ${truth.pricing.disclosure}`,
    prerequisites: `You need a Google account, a ${list(senders)} mailbox to send from, and your own ${list(models)} key.`,
    howToStart: `Sign in with Google, add your own ${list(models)} key and describe who you sell to.`,
    limitations: `Email goes from your own ${list(senders)} only, at most ${truth.limits.accountSendsPerDay} sends a day per account, to published addresses only. Not available: ${notShipped.join(', ')}.`,
    signupUrl: urls.signupUrl, bookingUrl: urls.bookingUrl,
    knownIntegrations: [...avail('channel'), ...avail('crm')].map(c => c.name),
  }
}
