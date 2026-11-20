// Fresh module only. No product router, provider, repository flag or storage is
// mounted here. Only a trusted application adapter may enable and bind a run.
import { runCompanyFirst, type CompanyFirstPorts, type Criteria, type Finding, type Scope } from './company-first-evidence.ts'
import { proveCompanyFirstContact, type CompanyFirstContactReaders, type CompanyFirstContactResult } from './company-first-contact-proof.ts'

type SignalFinding = Extract<Finding, { state: 'signal_verified' }>
type ContactProof = Extract<CompanyFirstContactResult, { status: 'contact_proof' }>
type Ready = Readonly<{ signal: SignalFinding; contact: ContactProof }>
type GateReceipt = Readonly<{
  scope: Scope; companyKey: string; website: string; identitySource: string; event: string; eventSource: string; eventDate: string;
  literalQuote: string; person: string; title: string; buyerBio: string; linkedIn: string; email: string; emailSource: string; verdict: 'ready' | 'held';
}>
type Policy = Readonly<{ enabled: boolean; signal?: AbortSignal }>
export interface CompanyFirstFinderPorts {
  evidence: CompanyFirstPorts
  contact: CompanyFirstContactReaders
  // Never a caller-supplied status field. Evaluates the SAME production holds
  // and a fully bound candidate using a trusted server-side adapter.
  checkExistingHolds(scope: Scope, row: Ready, signal: AbortSignal): Promise<GateReceipt | null>
  // False or missing must include unsettled/uncertain reservations. No
  // subsequent network/provider dispatch or public result when not affirmative.
  isCurrentAndSettled(scope: Scope): Promise<boolean>
}
const RUN_DEADLINE_MS = 8 * 60_000
function read<T>(signal: AbortSignal, f: () => Promise<T>): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise(resolve => {
    const cancel = () => done(undefined)
    const done = (v: T | undefined) => { signal.removeEventListener('abort', cancel); resolve(v) }
    signal.addEventListener('abort', cancel, { once: true })
    void Promise.resolve().then(() => signal.aborted ? undefined : f()).then(done, () => done(undefined))
  })
}
const isExactReady = (g: GateReceipt | null | undefined, s: Scope, r: Ready) =>
  g?.verdict === 'ready' && g.scope?.tenant === s.tenant && g.scope?.job === s.job && g.scope?.attempt === s.attempt &&
  g.companyKey === r.signal.site.companyKey && g.website === r.signal.site.website && g.identitySource === r.signal.site.identitySource &&
  g.event === r.signal.signal.event && g.eventSource === r.signal.signal.sourceUrl && g.eventDate === r.signal.signal.date &&
  g.literalQuote === r.signal.signal.quote && g.person === r.contact.buyer.name && g.title === r.contact.buyer.title &&
  g.buyerBio === r.contact.buyer.bioUrl && g.linkedIn === r.contact.buyer.linkedin &&
  g.email === r.contact.published.address && g.emailSource === r.contact.published.sourceUrl

export async function runCompanyFirstFinder(
  policy: Policy, rawScope: Scope, criteria: Criteria, requestedTitles: readonly string[], ports: CompanyFirstFinderPorts,
) {
  const stop = (state: 'disabled' | 'unavailable' | 'superseded_or_unsettled') => ({ state, ready: [] as readonly Ready[], observed: null })
  if (policy.enabled !== true) return stop('disabled')
  const scope = Object.freeze({ ...rawScope })
  const deadline = AbortSignal.timeout(RUN_DEADLINE_MS)
  const signal = policy.signal ? AbortSignal.any([policy.signal, deadline]) : deadline
  const stillCurrent = () => read(signal, () => ports.isCurrentAndSettled(scope))
  if (await stillCurrent() !== true) return stop('superseded_or_unsettled')
  const evidence = await runCompanyFirst({ enabled: true, signal }, scope, criteria, ports.evidence)
  if (signal.aborted || await stillCurrent() !== true) return stop('superseded_or_unsettled')
  if (evidence.state !== 'checked') return stop('unavailable')
  const observations = { signal_verified: 0, evidence_held: 0, contact_proven: 0, contact_held: 0, final_held: 0 }
  const contactHolds = new Map<string, number>()
  const ready: Ready[] = []
  for (const finding of evidence.findings) {
    if (finding.state !== 'signal_verified') { observations.evidence_held += finding.count; continue }
    observations.signal_verified++
    if (await stillCurrent() !== true) return stop('superseded_or_unsettled')
    const contact = await proveCompanyFirstContact(finding, requestedTitles, scope, ports.contact, signal)
    if (await stillCurrent() !== true) return stop('superseded_or_unsettled')
    if (contact.status !== 'contact_proof') {
      observations.contact_held++
      contactHolds.set(contact.reason, (contactHolds.get(contact.reason) ?? 0) + 1)
      continue
    }
    observations.contact_proven++
    const row = { signal: finding, contact }
    const receipt = await read(signal, () => ports.checkExistingHolds(scope, row, signal))
    if (await stillCurrent() !== true) return stop('superseded_or_unsettled')
    if (!isExactReady(receipt, scope, row)) { observations.final_held++; continue }
    ready.push(row)
  }
  if (await stillCurrent() !== true || signal.aborted) return stop('superseded_or_unsettled')
  // Held candidates, names, sources, and emails are never returned. No side effects.
  return { state: 'checked' as const, ready: ready as readonly Ready[], observed: { ...observations,
    evidence: evidence.observed ?? null, contact_holds: Object.fromEntries(contactHolds), ready_returned: ready.length, shown: null } }
}
