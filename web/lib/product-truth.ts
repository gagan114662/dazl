// The product truth record (#402): what dazl actually ships right now, built from the code and the deployment's flags,
// never from marketing prose. Sales copy, prospect qualification and routine buyer answers are checked against it
// (lib/outreach/capability-claims.ts), so dazl selling itself can only promise what this record says is shipped.
//
// Every entry comes from a code registry or flag:
//   sources       lib/channels.ts CHANNELS (live = available, worker = limited: needs an operator worker, soon = unavailable),
//                 then lib/advanced/config.ts PLATFORM_SUPPORT: a worker platform whose adapter is not built (Facebook,
//                 XiaoHongShu) is unavailable with nothing that enables it, never limited. Connecting an operator worker
//                 enables a built-but-disconnected source; it cannot enable an adapter nobody wrote (sourceCapability).
//   send channels SEND_CHANNELS below: Gmail is the only sender (lib/gmail/oauth.ts gmailSend); every other channel has
//                 no adapter in lib/ and is listed so a claim about it is recognised and refused
//   CRM           lib/crm/index.ts CRM_PROVIDERS; other CRMs are listed as unavailable for the same reason
//   models        lib/llm/vendors.ts VENDORS (the tenant's own key)
//   enrichment    lib/enrich (Apollo, PDL): the tenant's own key only (DECISIONS 2026-10-26: no paid data APIs)
//   features      trial scans (lib/billing/trial-budget.ts trialCaps), trial site reads (DAZL_TRIAL_SITE_READS_PER_DAY),
//                 Stripe checkout (STRIPE_SECRET_KEY + STRIPE_PRICE_PRO), the API/MCP service (#392, not built)
//   pricing       lib/plans.ts PLAN_LIMITS, PLAN_PRICE_USD_MONTHLY, PRICE_DISCLOSURE
//   benchmarks    BENCHMARKS below: empty until a recorded #372 scorecard run is published
//
// version is a hash of everything else: any change to a capability, a flag, a price or the claim vocabulary yields a
// new version, which invalidates drafts and routine answers prepared under the old one (capability-claims.ts).
import { createHash } from 'node:crypto'
import { CHANNELS } from './channels.ts'
import { PLAN_LIMITS, PLAN_PRICE_USD_MONTHLY, PRICE_DISCLOSURE, type PlanId } from './plans.ts'
import { VENDORS } from './llm/vendors.ts'
import { CRM_PROVIDERS } from './crm/index.ts'
import { trialCaps, TRIAL_REQUIRES } from './billing/trial-budget.ts'
import { TRIAL_SCANS_PER_ACCOUNT } from './scan/trial.ts'
import { trialSiteReadsPerDay } from './scan/trial-site-read.ts'
import { ACCOUNT_SEND_CAP } from './outreach/send-budget.ts'
import { PLATFORM_SUPPORT } from './advanced/config.ts'

export const PRODUCT_TRUTH_SCHEMA = 1

export type CapabilityState = 'available' | 'limited' | 'unavailable'
export type CapabilityKind = 'source' | 'channel' | 'crm' | 'model' | 'enrichment' | 'feature'
// own_key: works only on the tenant's own provider key; operator_worker: needs a worker dazl does not run.
export type Requirement = 'own_key' | 'operator_worker' | 'google_account' | 'own_crm_token'
export interface Capability {
  id: string
  kind: CapabilityKind
  name: string
  state: CapabilityState
  requires: Requirement[]
  aliases: string[]          // regex sources (case-insensitive, word-bounded) that name this capability in copy
  basis: string              // the code or flag the state is read from
}
export interface Benchmark { url: string; competitors: string[]; scope: string; measuredAt: string }
export interface ProductTruth {
  schema: number
  version: string
  capabilities: Capability[]
  pricing: {
    currency: 'USD'
    plans: { id: PlanId; monthlyUsd: number; scansPerMonth: number | null }[]
    checkoutAvailable: boolean
    ownAiKeyRequired: true
    providerCostSeparate: true
    disclosure: string
  }
  limits: { accountSendsPerDay: number; trialScansPerAccount: number }
  markets: { contactAddresses: 'published_only' }
  competitors: string[]
  benchmarks: Benchmark[]
}

// Send channels: only Gmail has an adapter. The rest are named so that a promise of them is caught, never invented.
const SEND_CHANNELS: Omit<Capability, 'kind'>[] = [
  { id: 'channel:gmail', name: 'Gmail', state: 'available', requires: ['google_account'], aliases: ['gmail', 'google workspace', 'cold emails?', 'email outreach'], basis: 'lib/gmail/oauth.ts gmailSend' },
  { id: 'channel:outlook', name: 'Outlook / Microsoft 365 sending', state: 'unavailable', requires: [], aliases: ['outlook', 'microsoft 365', 'office 365', 'ms ?365', 'exchange server'], basis: 'no adapter in lib/' },
  { id: 'channel:smtp', name: 'SMTP / other mail senders', state: 'unavailable', requires: [], aliases: ['smtp', 'sendgrid', 'mailgun', 'amazon ses', 'custom mail server'], basis: 'no adapter in lib/' },
  { id: 'channel:linkedin_messaging', name: 'LinkedIn messages', state: 'unavailable', requires: [], aliases: ['linkedin (?:outreach|messag\\w*|dms?|inmails?|automation|connection requests?|sequences?)', 'inmails?'], basis: 'no adapter in lib/' },
  { id: 'channel:sms', name: 'SMS', state: 'unavailable', requires: [], aliases: ['sms', 'text messag\\w*'], basis: 'no adapter in lib/' },
  { id: 'channel:whatsapp', name: 'WhatsApp', state: 'unavailable', requires: [], aliases: ['whatsapp'], basis: 'no adapter in lib/' },
  { id: 'channel:phone', name: 'Phone / dialer', state: 'unavailable', requires: [], aliases: ['cold call\\w*', 'dialers?', 'voicemail drops?', 'phone outreach', 'power dialer'], basis: 'no adapter in lib/' },
]
const UNAVAILABLE_CRMS: [string, string, string[]][] = [
  ['salesforce', 'Salesforce', ['salesforce', 'sfdc']],
  ['zoho', 'Zoho CRM', ['zoho(?: crm)?']],
  ['close', 'Close CRM', ['close crm', 'close\\.com']],
  ['attio', 'Attio', ['attio']],
  ['dynamics', 'Microsoft Dynamics', ['dynamics 365', 'microsoft dynamics']],
]
const CRM_NAMES: Record<string, [string, string[]]> = {
  hubspot: ['HubSpot', ['hubspot']],
  pipedrive: ['Pipedrive', ['pipedrive']],
  webhook: ['Webhook', ['webhooks?']],
}
const MODEL_NAMES: Record<string, [string, string[]]> = {
  anthropic: ['Anthropic (Claude) on your own key', ['anthropic', 'claude (?:ai|models?|api|sonnet|opus|haiku)']],
  openai: ['OpenAI on your own key', ['openai', 'gpt-?\\d\\w*']],
}
const SOURCE_ALIASES: Record<string, string[]> = {
  web: ['jina reader'], youtube: ['youtube'], github: ['github'], rss: ['rss(?: feeds?)?'], search: [], v2ex: ['v2ex'],
  x: ['twitter', 'x\\.com'], reddit: ['reddit'], instagram: ['instagram'], facebook: ['facebook'], bilibili: ['bilibili'],
  xiaohongshu: ['xiaohongshu', 'rednote'], linkedin: ['linkedin'],
}
// The comparisons copy may not make without a published benchmark of that competitor (#372).
export const COMPETITORS = ['pancake', 'gojiberry', 'chatgpt', 'apollo', 'clay', 'zoominfo', 'lemlist', 'instantly', 'smartlead']
// Published benchmark runs. Empty: the #372 benchmark has never been run. An entry is added only with a recorded
// scorecard run (lib/benchmark/scorecard.ts) at a public https URL, its competitors and scope; the owner decides.
export const BENCHMARKS: Benchmark[] = []

type Env = Record<string, string | undefined>
type Channel = (typeof CHANNELS)[number]
export type PlatformSupport = Record<string, { supported: boolean; reason: string | null } | undefined>

// One source's capability. Three distinct states, each with what (if anything) turns it on:
//   available    status live, and no unbuilt adapter behind it
//   limited      built, but needs an operator worker session (status worker, adapter supported)
//   unavailable  status soon, or the platform's adapter is not built or has no PLATFORM_SUPPORT entry at all (fail
//                closed: an unknown platform is never assumed built); requires is empty because no setup enables it
export function sourceCapability(c: Channel, support: PlatformSupport = PLATFORM_SUPPORT): Capability {
  const base = { id: `source:${c.id}`, kind: 'source' as const, name: c.name, aliases: SOURCE_ALIASES[c.id] ?? [] }
  if (c.platform !== undefined) {
    const s = Object.prototype.hasOwnProperty.call(support, c.platform) ? support[c.platform] : undefined
    if (!s || typeof s !== 'object' || s.supported !== true) {
      const why = !s || typeof s !== 'object' ? 'no PLATFORM_SUPPORT entry' : `unsupported: ${typeof s.reason === 'string' && s.reason.trim() ? s.reason.trim() : 'adapter not built'}`
      return { ...base, state: 'unavailable', requires: [], basis: `lib/advanced/config.ts PLATFORM_SUPPORT ${c.platform}: ${why}` }
    }
  }
  return {
    ...base,
    state: c.status === 'live' ? 'available' : c.status === 'worker' ? 'limited' : 'unavailable',
    requires: c.status === 'worker' ? ['operator_worker'] : [],
    basis: `lib/channels.ts ${c.id}: ${c.status}`,
  }
}

function capabilities(env: Env, support: PlatformSupport): Capability[] {
  const out: Capability[] = []
  for (const c of CHANNELS) out.push(sourceCapability(c, support))
  for (const s of SEND_CHANNELS) out.push({ ...s, kind: 'channel' })
  for (const p of CRM_PROVIDERS) {
    const [name, aliases] = CRM_NAMES[p] ?? [p, [p]]
    out.push({ id: `crm:${p}`, kind: 'crm', name, state: 'available', requires: ['own_crm_token'], aliases, basis: 'lib/crm/index.ts CRM_PROVIDERS' })
  }
  for (const [id, name, aliases] of UNAVAILABLE_CRMS) out.push({ id: `crm:${id}`, kind: 'crm', name, state: 'unavailable', requires: [], aliases, basis: 'not in CRM_PROVIDERS' })
  for (const v of VENDORS) {
    const [name, aliases] = MODEL_NAMES[v] ?? [v, [v]]
    out.push({ id: `model:${v}`, kind: 'model', name, state: 'available', requires: ['own_key'], aliases, basis: 'lib/llm/vendors.ts VENDORS' })
  }
  out.push({ id: 'model:other', kind: 'model', name: 'Other model providers', state: 'unavailable', requires: [], aliases: ['gemini', 'mistral', 'grok', 'llama'], basis: 'not in VENDORS' })
  out.push({ id: 'enrichment:apollo', kind: 'enrichment', name: 'Apollo enrichment on your own key', state: 'limited', requires: ['own_key'], aliases: ['apollo(?:\\.io)?'], basis: 'lib/enrich/apollo.ts, tenant key only' })
  out.push({ id: 'enrichment:pdl', kind: 'enrichment', name: 'People Data Labs enrichment on your own key', state: 'limited', requires: ['own_key'], aliases: ['people data labs', 'pdl'], basis: 'lib/enrich/pdl.ts, tenant key only' })
  const trialOn = trialCaps(env) !== null
  out.push({ id: 'feature:trial_scans', kind: 'feature', name: `Free trial scans on dazl's keys (${TRIAL_SCANS_PER_ACCOUNT} per account)`, state: trialOn ? 'available' : 'unavailable', requires: [...TRIAL_REQUIRES], aliases: ['free trial', 'no (?:api |ai )?key (?:needed|required)', 'without (?:an? |your own )?(?:api |ai )?key'], basis: 'lib/billing/trial-budget.ts trialCaps(env), TRIAL_REQUIRES' })
  out.push({ id: 'feature:trial_site_read', kind: 'feature', name: 'Website read on the free trial', state: trialSiteReadsPerDay(env) !== null ? 'available' : 'unavailable', requires: [...TRIAL_REQUIRES], aliases: [], basis: 'DAZL_TRIAL_SITE_READS_PER_DAY; lib/billing/trial-budget.ts TRIAL_REQUIRES' })
  out.push({ id: 'feature:api_mcp', kind: 'feature', name: 'API / MCP access (ChatGPT, Zapier)', state: 'unavailable', requires: [], aliases: ['mcp', 'api access', 'public api', 'zapier', 'chatgpt (?:plugin|app|connector)'], basis: '#392 not built' })
  return out
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

// The record for this deployment. Pure: the same code and env always give the same record and version.
// support defaults to the shipped PLATFORM_SUPPORT; a test passes another one to show the record and its version follow it.
export function productTruth(env: Env = process.env, support: PlatformSupport = PLATFORM_SUPPORT): ProductTruth {
  const body: Omit<ProductTruth, 'version'> = {
    schema: PRODUCT_TRUTH_SCHEMA,
    capabilities: capabilities(env, support),
    pricing: {
      currency: 'USD',
      plans: (Object.keys(PLAN_LIMITS) as PlanId[]).map(id => ({ id, monthlyUsd: PLAN_PRICE_USD_MONTHLY[id], scansPerMonth: PLAN_LIMITS[id].scansPerMonth })),
      checkoutAvailable: !!(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_PRO),
      ownAiKeyRequired: true,
      providerCostSeparate: true,
      disclosure: PRICE_DISCLOSURE,
    },
    limits: { accountSendsPerDay: ACCOUNT_SEND_CAP, trialScansPerAccount: TRIAL_SCANS_PER_ACCOUNT },
    markets: { contactAddresses: 'published_only' },
    competitors: COMPETITORS,
    benchmarks: BENCHMARKS,
  }
  return { ...body, version: `pt-${sha(JSON.stringify(body)).slice(0, 16)}` }
}

export const PRODUCT_TRUTH_VERSION_RE = /^pt-[0-9a-f]{16}$/
