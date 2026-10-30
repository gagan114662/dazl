// What dazl can do today (#402), derived from the shipped configuration rather than written by hand: the channel
// registry, the CRM targets, the model vendors, plan limits and prices. Prospect qualification and sales copy are
// checked against it, so a buyer who needs something unavailable is waitlisted instead of promised it, and a claim
// the product cannot back is flagged before it is sent. The version is a digest of the content: when the shipped
// capability changes, the version changes, and anything stamped with the old version is known to be stale.
import { createHash } from 'node:crypto'
import { CHANNELS } from './channels.ts'
import { VENDORS } from './llm/vendors.ts'
import { CRM_PROVIDERS } from './crm/index.ts'
import { PLAN_LIMITS } from './plans.ts'
import { PLAN_PRICES_USD_MONTH } from './pricing.ts'

export interface ProductTruth {
  version: string
  senders: string[]                                   // mailboxes outreach sends from
  crm: string[]                                       // CRM push targets
  modelVendors: string[]                              // bring-your-own model keys
  sources: { live: string[]; operatorWorker: string[] } // lead sources; worker ones need an operator-run worker
  plans: { id: string; usdPerMonth: number; scansPerMonth: number | null }[]
  costExclusions: string[]                            // costs the plan price does not include
  setup: string[]                                     // prerequisites before the product works
  unavailable: string[]                               // asked for, not built: never promised
}

// Capabilities a buyer may require that are not built. Kept here, next to the record, so adding one is a reviewed
// change that moves the version.
const NOT_BUILT = ['sender:outlook', 'sender:smtp', 'channel:sms', 'channel:whatsapp', 'channel:phone', 'channel:linkedin_messaging', 'crm:salesforce', 'crm:zoho', 'crm:close']

function digest(x: unknown): string {
  return createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 12)
}

export function productTruth(): ProductTruth {
  const body = {
    senders: ['gmail'],
    crm: [...CRM_PROVIDERS],
    modelVendors: [...VENDORS],
    sources: {
      live: CHANNELS.filter(c => c.status === 'live').map(c => c.id),
      operatorWorker: CHANNELS.filter(c => c.status === 'worker').map(c => c.id),
    },
    plans: (Object.keys(PLAN_LIMITS) as (keyof typeof PLAN_LIMITS)[]).map(id => ({ id, usdPerMonth: PLAN_PRICES_USD_MONTH[id], scansPerMonth: PLAN_LIMITS[id].scansPerMonth })),
    costExclusions: ['model usage on your own AI key, billed by your provider'],
    setup: ['a Google account', 'your own Anthropic or OpenAI key', 'a connected Gmail mailbox to send'],
    unavailable: [...NOT_BUILT, ...CHANNELS.filter(c => c.status === 'soon').map(c => `source:${c.id}`)],
  }
  return { version: digest(body), ...body }
}

// A buyer requirement in their words, mapped to a capability key. First match wins, so the more specific pattern
// (LinkedIn messaging) comes before the general one (LinkedIn as a lead source).
const REQUIREMENTS: [RegExp, string][] = [
  [/\b(?:outlook|office ?365|microsoft 365|exchange)\b/i, 'sender:outlook'],
  [/\bsmtp\b|\bown mail ?server\b/i, 'sender:smtp'],
  [/\bgmail\b|\bgoogle workspace\b/i, 'sender:gmail'],
  [/\b(?:sms|text messag(?:e|es|ing))\b/i, 'channel:sms'],
  [/\bwhats ?app\b/i, 'channel:whatsapp'],
  [/\b(?:dialer|cold call(?:s|ing)?|phone calls?)\b/i, 'channel:phone'],
  [/\blinked ?in (?:dms?|messag\w*|inmail|automation|outreach)\b|\binmail\b/i, 'channel:linkedin_messaging'],
  [/\bsalesforce\b/i, 'crm:salesforce'],
  [/\bzoho\b/i, 'crm:zoho'],
  [/\bclose\.com\b|\bclose crm\b/i, 'crm:close'],
  [/\bhub ?spot\b/i, 'crm:hubspot'],
  [/\bpipedrive\b/i, 'crm:pipedrive'],
  [/\bwebhooks?\b|\bzapier\b/i, 'crm:webhook'],
  [/\blinked ?in\b/i, 'source:linkedin'],
  [/\breddit\b/i, 'source:reddit'],
  [/\b(?:twitter|x\.com)\b/i, 'source:x'],
  [/\bgithub\b/i, 'source:github'],
  [/\byoutube\b/i, 'source:youtube'],
]

export const requirementKey = (text: string): string | null => REQUIREMENTS.find(([re]) => re.test(text))?.[1] ?? null

function available(truth: ProductTruth, key: string): 'yes' | 'operator' | 'no' {
  if (truth.unavailable.includes(key)) return 'no'
  const [kind, id] = key.split(':')
  if (kind === 'sender') return truth.senders.includes(id) ? 'yes' : 'no'
  if (kind === 'crm') return truth.crm.includes(id) ? 'yes' : 'no'
  if (kind === 'source') return truth.sources.live.includes(id) ? 'yes' : truth.sources.operatorWorker.includes(id) ? 'operator' : 'no'
  return 'no'
}

export interface Qualification {
  verdict: 'fit' | 'waitlist' | 'needs_review'
  unavailable: string[]  // required, not built: waitlist, never promise
  operator: string[]     // works only where the operator runs a worker: not promised as self-serve
  unknown: string[]      // requirements the record does not cover: a person decides, the product does not guess
  truthVersion: string
}

// Qualify a prospect's stated requirements against what ships. Any unavailable requirement waitlists the prospect;
// an operator-dependent or unrecognised one needs review. Only a prospect whose every requirement ships is a fit.
export function qualifyRequirements(requirements: string[], truth = productTruth()): Qualification {
  const out: Qualification = { verdict: 'fit', unavailable: [], operator: [], unknown: [], truthVersion: truth.version }
  for (const r of requirements.map(s => s.trim()).filter(Boolean)) {
    const key = requirementKey(r)
    if (!key) { out.unknown.push(r); continue }
    const a = available(truth, key)
    if (a === 'no') out.unavailable.push(key)
    else if (a === 'operator') out.operator.push(key)
  }
  out.verdict = out.unavailable.length ? 'waitlist' : out.operator.length || out.unknown.length ? 'needs_review' : 'fit'
  return out
}

export interface Benchmark { competitor: string; url: string; scope: string }
export type ClaimIssue =
  | { kind: 'unavailable_capability'; capability: string; text: string }
  | { kind: 'unbenchmarked_comparison'; competitor: string; text: string }
  | { kind: 'missing_cost_disclosure'; text: string }

const NEGATION = /\b(?:not|no|doesn'?t|does not|don'?t|do not|isn'?t|without|never|can'?t|cannot|won'?t)\b[^.!?]{0,40}$/i
const COMPARISON = /\b(?:better|faster|cheaper|more accurate|smarter)(?:\s+[a-z]+){0,3}\s+than\s+([A-Z][\w.]*(?:\s[A-Z][\w.]*)?)|\b(?:beats?|outperforms?|replaces?)\s+([A-Z][\w.]*(?:\s[A-Z][\w.]*)?)/g
const PRICE = /\$\s?\d|\bper month\b|\/mo\b|\bpricing\b|\bprice\b/i
const COST_DISCLOSED = /\bown (?:ai |model |llm )?(?:api )?key\b|\bbyok\b|\bbilled separately\b|\bprovider bills?\b/i

// Check outbound copy against the record: an unavailable capability offered (not negated), a comparison with a named
// competitor without a linked benchmark for that competitor, or a price with no disclosure that model usage is billed
// separately on the buyer's own key.
export function claimIssues(text: string, benchmarks: Benchmark[] = [], truth = productTruth()): ClaimIssue[] {
  const issues: ClaimIssue[] = []
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/).filter(s => s.trim())) {
    for (const [re, key] of REQUIREMENTS) {
      const m = re.exec(sentence)
      if (!m || available(truth, key) !== 'no') continue
      if (NEGATION.test(sentence.slice(0, m.index))) continue
      issues.push({ kind: 'unavailable_capability', capability: key, text: sentence.trim() })
    }
    for (const m of sentence.matchAll(COMPARISON)) {
      const competitor = (m[1] ?? m[2]).trim().replace(/\.+$/, '')
      const ok = benchmarks.some(b => b.competitor.toLowerCase() === competitor.toLowerCase() && /^https:\/\//.test(b.url) && b.scope.trim())
      if (!ok) issues.push({ kind: 'unbenchmarked_comparison', competitor, text: sentence.trim() })
    }
  }
  if (PRICE.test(text) && !COST_DISCLOSED.test(text)) issues.push({ kind: 'missing_cost_disclosure', text: text.match(PRICE)![0] })
  return issues
}
