// The published source-capability matrix for one workspace (#762, part of #388): every MATRIX entry with its availability FOR THIS TENANT.
// Three distinct states, never collapsed: available, unavailable (built, but its worker is switched off / not connected / not consented: "not
// checked", never "0 opportunities") and not_built (no adapter exists; no setup enables it). Served by GET /api/sources/capabilities.
import { MATRIX, availability, advertisable, defaultEligible, sourceStatusLine, type Availability, type Capability } from './capability-matrix.ts'
import { connectorId, platformAllowed, type AdvFlags, type AdvPlatform } from '../advanced/config.ts'

export interface WorkerState { connectors: { connector: string; enabled: boolean }[]; consented: ReadonlySet<AdvPlatform>; flags: AdvFlags; xViaOperatorIndex: boolean }
export interface CapabilityRow {
  id: string; label: string; status: Capability['status']; availability: Availability; statusLine: string
  signals: string[]; markets: string[]; languages: string[]; refresh: string; identityProof: Capability['identityProof']; dateProof: Capability['dateProof']
  access: Capability['access']; license: string; failureReporting: string; evidence: Capability['evidence']
  advertisable: boolean; defaultEligible: boolean; blocker: string | null
}

// A worker platform counts as connected only when the operator switched its tier on AND the tenant consented AND it has a stored enabled session (X also
// works with no session through the operator's public-index key). Anything less is unavailable - a scan would audit disabled / no_consent / worker_error.
export function connectedWorkers(w: WorkerState, matrix: Capability[] = MATRIX): Set<string> {
  const out = new Set<string>()
  for (const c of matrix) {
    const p = c.worker; if (!p || !platformAllowed(p, w.flags) || !w.consented.has(p)) continue
    if (w.connectors.some(x => x.connector === connectorId(p) && x.enabled) || (p === 'x' && w.xViaOperatorIndex)) out.add(p)
  }
  return out
}

export function capabilityReport(w: WorkerState, matrix: Capability[] = MATRIX): CapabilityRow[] {
  const connected = { workers: connectedWorkers(w, matrix) }
  return matrix.map(c => {
    const a = availability(c, connected)
    return {
      id: c.id, label: c.label, status: c.status, availability: a, statusLine: sourceStatusLine(c, a),
      signals: c.signals, markets: c.markets, languages: c.languages, refresh: c.refresh, identityProof: c.identityProof, dateProof: c.dateProof,
      access: c.access, license: c.license, failureReporting: c.failureReporting, evidence: c.evidence,
      advertisable: advertisable(c), defaultEligible: defaultEligible(c), blocker: c.blocker ?? null,
    }
  })
}
