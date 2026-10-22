// Push a lead to the tenant's own CRM. Per-user credentials stored encrypted in the
// connectors vault (never returned by any API). Three targets: HubSpot (private-app
// token), Pipedrive (API token), or a generic HTTPS webhook the tenant controls.
// A push failure is reported to the caller, never swallowed silently.
import type Database from 'better-sqlite3'
import { getEnabledCredential, saveCredential, deleteCredential, audit } from '../connectors/store.ts'
import { fetchPublicHtml, defaultLookup, type Lookup } from '../net/public-fetch.ts'

export type CrmProvider = 'hubspot' | 'pipedrive' | 'webhook'
export interface CrmConfig { provider: CrmProvider; key?: string; url?: string }
export interface CrmLead { company: string; name: string; contact: string | null; signal: string; source_url: string; fit?: number | null; intent?: number | null; why?: string | null }

const CONNECTOR = 'crm'
const TIMEOUT = 10_000

export function saveCrmConfig(db: Database.Database, tenantId: string, cfg: CrmConfig, master?: Buffer): void {
  saveCredential(db, tenantId, CONNECTOR, JSON.stringify(cfg), master)
}
export function getCrmConfig(db: Database.Database, tenantId: string, master?: Buffer): CrmConfig | null {
  const raw = getEnabledCredential(db, tenantId, CONNECTOR, master)
  if (!raw) return null
  try {
    const c = JSON.parse(raw) as CrmConfig
    if (!['hubspot', 'pipedrive', 'webhook'].includes(c.provider)) return null
    if (c.provider === 'webhook' && !/^https:\/\/\S{4,400}$/.test(c.url ?? '')) return null
    if (c.provider !== 'webhook' && !(c.key ?? '').trim()) return null
    return c
  } catch { return null }
}
export const disconnectCrm = (db: Database.Database, tenantId: string): boolean => deleteCredential(db, tenantId, CONNECTOR)

// Returns a short human-facing confirmation (what was created where), throws on failure.
export async function pushLead(cfg: CrmConfig, lead: CrmLead, fetchImpl?: typeof fetch, deps: { lookup?: Lookup } = {}): Promise<string> {
  const name = lead.name || lead.company
  if (cfg.provider === 'hubspot') {
    const [firstname, ...rest] = name.split(' ')
    const res = await (fetchImpl ?? fetch)('https://api.hubapi.com/crm/v3/objects/contacts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ properties: { email: lead.contact ?? undefined, firstname, lastname: rest.join(' ') || undefined, company: lead.company, hs_lead_status: 'NEW' } }),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (res.status === 409) return 'Already in HubSpot (matching contact exists)'
    if (!res.ok) throw new Error(`HubSpot ${res.status}`)
    return 'Contact created in HubSpot'
  }
  if (cfg.provider === 'pipedrive') {
    const res = await (fetchImpl ?? fetch)(`https://api.pipedrive.com/v1/persons?api_token=${encodeURIComponent(cfg.key ?? '')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, email: lead.contact ?? undefined, org_name: lead.company }),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (!res.ok) throw new Error(`Pipedrive ${res.status}`)
    const j = await res.json().catch(() => null) as { success?: boolean } | null
    if (j?.success === false) throw new Error('Pipedrive rejected the contact')
    return 'Person created in Pipedrive'
  }
  // generic webhook: the tenant's own HTTPS endpoint gets the full lead payload.
  // Tenant-controlled URL, so the POST goes through the SSRF guard at push time (DNS can
  // be re-pointed after the URL was saved): public addresses only, pinned at connect time,
  // redirects are NOT followed (a redirecting webhook is reported as the 3xx it returns).
  const r = await fetchPublicHtml(cfg.url!, {
    fetchImpl,
    lookup: deps.lookup ?? defaultLookup,
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'dazl-crm-webhook/1.0' },
    body: JSON.stringify({ source: 'dazl', event: 'lead.pushed', lead: { company: lead.company, name: lead.name, contact: lead.contact, signal: lead.signal, source_url: lead.source_url, fit: lead.fit ?? null, intent: lead.intent ?? null, why: lead.why ?? null }, at: new Date().toISOString() }),
    accept: null,
    maxBytes: 64_000,
    timeoutMs: TIMEOUT,
  })
  if ('error' in r) throw new Error(r.error === 'not_public' ? 'Webhook address is not public' : r.status ? `Webhook ${r.status}` : `Webhook ${r.error}`)
  return 'Lead sent to your webhook'
}

// Audit one push attempt (success or error) on the connectors settings page.
export function auditPush(db: Database.Database, tenantId: string, provider: string, leadCompany: string, ok: boolean): void {
  audit(db, { tenantId, connector: `crm:${provider}`, lookup: leadCompany.slice(0, 200), status: ok ? 'ok' : 'worker_error', results: ok ? 1 : 0 })
}
