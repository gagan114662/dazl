// Fresh company-first subsystem only. No executable entrypoint or default
// provider. The flag must be injected by its audited server caller (off today).
const CASE_MAX_MICROS = 5_000_000
const PER_BATCH_MAX_USES = 5
const MAX_USES_PER_CASE = 20
const LOOKBACK_S = 14 * 86400

export type CaseScope = Readonly<{ caseId: string; attempt: number }>
export type Query = Readonly<{ id: string; prompt: string; fallbackMicros: number; cohort: string; maxUses: number }>
export type Sample = Readonly<{ id: string; cohort: string; maxUses: number; settledAt: number; actualMicros: number; status: 'production_settled' }>
export type Quote = Readonly<{ id: string; reserveMicros: number; maxUses: number; cohort: string }>
export type Lease = Readonly<{ id: string; scope: CaseScope; chargedTo: 'shared_case_budget'; totalMicros: number; caseAuthorizedSearches: number; quotes: readonly Quote[] }>
export type Settlement = Readonly<{ id: string; state: 'known'; actualMicros: number } | { id: string; state: 'uncertain' }>
export type CallResult<T> =
  | { state: 'settled'; actualMicros: number; searches: number; evidence: T }
  | { state: 'refused'; actualMicros: number | null }
  | { state: 'uncertain' }

export type Dependencies<T> = Readonly<{
  approvedCohorts: ReadonlySet<string>
  // Exact private paid-usage cohort; no query, content, tenant or customer identity.
  recent: (cohort: string, maxUses: number) => Promise<readonly Sample[]>
  // Must arm one fenced, durable shared-case transaction across all engines and
  // judge, including all existing payer/day/account bounds AND cumulative
  // search allowances across attempts of this case. Refuse while a different
  // batch is unresolved or an uncertain attempt is latched. Never widen the
  // effective stored cap based on caller text or this method’s cap argument.
  reserveBatch: (scope: CaseScope, effectiveCapMicros: number, quotes: readonly Quote[]) => Promise<Lease | null>
  // Reserve CAS and same-attempt ownership must remain valid up to the paid send.
  call: (query: Query, lease: Lease) => Promise<CallResult<T>>
  // Commit reconciled authentic actuals and keep the entire reserved amount for
  // unknown/rejected billing. Must be idempotent and fenced to the exact lease.
  settleBatch: (lease: Lease, settlements: readonly Settlement[]) => Promise<boolean>
}>

const integer = (n: unknown, min: number, max: number): n is number =>
  Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max
const idOk = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(s)
const smallestUnit = (n: number) => Math.ceil(n * 3 / 2)

export function measuredQuote(query: Query, now: number, samples: readonly Sample[]): Quote {
  if (!integer(now,1,Number.MAX_SAFE_INTEGER) || !integer(query.maxUses,1,PER_BATCH_MAX_USES) ||
      !integer(query.fallbackMicros,1,CASE_MAX_MICROS) || samples.length > 512) throw Error('bad_quote')
  const seen = new Set<string>()
  const rows = samples.filter(r => r.status === 'production_settled' && r.cohort === query.cohort && r.maxUses === query.maxUses &&
      idOk(r.id) && integer(r.settledAt, Math.max(1,now-LOOKBACK_S),now) && integer(r.actualMicros,1,Number.MAX_SAFE_INTEGER/2))
    .sort((a,b) => b.settledAt-a.settledAt || b.actualMicros-a.actualMicros)
    .filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true }).slice(0,20)
  const fallback = rows.length < 20 ? smallestUnit(query.fallbackMicros) : query.fallbackMicros
  const reserveMicros = Math.max(fallback,smallestUnit(Math.max(0,...rows.map(r => r.actualMicros))))
  return Object.freeze({id:query.id,cohort:query.cohort,maxUses:query.maxUses,reserveMicros})
}

const matches = (lease: Lease, scope: CaseScope, quotes: readonly Quote[], sum: number) =>
  idOk(lease.id) && lease.scope.caseId === scope.caseId && lease.scope.attempt === scope.attempt &&
  lease.chargedTo === 'shared_case_budget' && lease.totalMicros === sum && integer(lease.caseAuthorizedSearches, quotes.reduce((n,q)=>n+q.maxUses,0), MAX_USES_PER_CASE) && lease.quotes.length === quotes.length &&
  quotes.every((q,i) => { const given=lease.quotes[i]; return given.id===q.id && given.cohort===q.cohort && given.maxUses===q.maxUses && given.reserveMicros===q.reserveMicros })

export async function runBudgetedCompanyQueries<T>(input: Readonly<{
  enabled: boolean
  payer: 'own_key' | 'trial'
  scope: CaseScope
  // Trusted existing cap (not an advisory user setting); the shared store is authoritative.
  effectiveCapMicros: number
  now: number
  batches: readonly (readonly Query[])[]
}>, deps: Dependencies<T>) {
  const evidence: T[] = []
  let authorizedSearches = 0
  const stop = (reason:'disabled'|'ineligible'|'invalid_plan'|'reservation_refused'|'accounting_uncertain'|'provider_refused'|'estimate_exceeded'|'provider_limit'|'planned_limit') =>
    ({reason,evidence:[...evidence],authorizedSearches,softEstimate:true as const})
  if (input.enabled !== true) return stop('disabled')
  if (input.payer !== 'own_key') return stop('ineligible')
  const scope = Object.freeze({...input.scope}), cap = input.effectiveCapMicros, now = input.now
  if (!idOk(scope.caseId) || !integer(scope.attempt,1,Number.MAX_SAFE_INTEGER) || !integer(cap,1,CASE_MAX_MICROS) ||
      !integer(now,1,Number.MAX_SAFE_INTEGER) || !integer(input.batches.length,1,MAX_USES_PER_CASE)) return stop('invalid_plan')
  const ids = new Set<string>(), prompts = new Set<string>()
  let planned = 0
  const batches: Query[][] = []
  for (const batch of input.batches) {
    if (!integer(batch.length,1,PER_BATCH_MAX_USES)) return stop('invalid_plan')
    let uses = 0
    const copy: Query[] = []
    for (const raw of batch) {
      const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
      if (!idOk(raw.id) || !prompt || new TextEncoder().encode(prompt).length > 24_000 || ids.has(raw.id) || prompts.has(prompt) ||
          !integer(raw.maxUses,1,PER_BATCH_MAX_USES) || !integer(raw.fallbackMicros,1,CASE_MAX_MICROS) ||
          typeof raw.cohort !== 'string' || !deps.approvedCohorts.has(raw.cohort)) return stop('invalid_plan')
      copy.push(Object.freeze({...raw,prompt}))
      ids.add(raw.id); prompts.add(prompt); uses += raw.maxUses
    }
    if (uses > PER_BATCH_MAX_USES || (planned += uses) > MAX_USES_PER_CASE) return stop('invalid_plan')
    batches.push(copy)
  }
  let chargedMicros = 0
  for (const batch of batches) {
    let quotes: readonly Quote[]
    try { quotes = Object.freeze(await Promise.all(batch.map(async q=>measuredQuote(q,now,await deps.recent(q.cohort,q.maxUses))))) }
    catch { return stop('reservation_refused') } // a broken lookup is not a healthy empty history
    const sum = quotes.reduce((n,q)=>n+q.reserveMicros,0)
    if (!integer(sum,1,cap) || chargedMicros + sum > cap) return stop('reservation_refused')
    let lease: Lease | null
    try { lease = await deps.reserveBatch(scope,cap,quotes) } catch { return stop('reservation_refused') }
    try { if (!lease || !matches(lease,scope,quotes,sum)) return stop('reservation_refused') }
    catch { return stop('reservation_refused') }
    authorizedSearches += quotes.reduce((n,q)=>n+q.maxUses,0)
    // No request starts until the *whole batch* reserve has committed.
    const results = await Promise.all(batch.map(async q => {
      try { return await deps.call(q,lease) } catch { return {state:'uncertain'} as const }
    }))
    const actuals: Settlement[] = []
    let uncertain = false, exceeded = false, rejected = false, providerLimit = false
    for (const [i,r] of results.entries()) {
      const q = quotes[i]
      if (!r || (r.state !== 'settled' && r.state !== 'refused') || !integer(r.actualMicros,0,Number.MAX_SAFE_INTEGER/2)) {
        uncertain = true; actuals.push({id:q.id,state:'uncertain'}); continue
      }
      actuals.push({id:q.id,state:'known',actualMicros:r.actualMicros}); chargedMicros += r.actualMicros
      if (r.actualMicros > q.reserveMicros) exceeded = true
      if (r.state === 'refused') rejected = true
      else if (!integer(r.searches,0,q.maxUses)) providerLimit = true
    }
    try { if (!await deps.settleBatch(lease,Object.freeze(actuals))) return stop('accounting_uncertain') }
    catch { return stop('accounting_uncertain') }
    if (uncertain) return stop('accounting_uncertain')
    if (providerLimit) return stop('provider_limit')
    if (exceeded) return stop('estimate_exceeded')
    if (rejected) return stop('provider_refused')
    for (const r of results) if (r.state === 'settled') evidence.push(r.evidence)
  }
  return stop('planned_limit')
}
