// Push a lead to the tenant's own CRM. Per-user credentials stored encrypted in the
// connectors vault (never returned by any API). Three targets: HubSpot (private-app
// token), Pipedrive (API token), or a generic HTTPS webhook the tenant controls.
// A push failure is reported to the caller, never swallowed silently.
import { createHash } from 'node:crypto'
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

// What a push did. 'failed': the CRM definitely created nothing (a refusal, a bad key, a rate limit), so trying again
// is safe. 'unknown': the create may or may not have happened (a server error, a timeout after the request went out,
// a success status without a readable record id), so trying again could create a duplicate: the caller must not retry
// blindly (see pushBlocked) until someone checks the CRM.
export type PushFailure = 'failed' | 'unknown'
export class CrmPushError extends Error {
  readonly outcome: PushFailure
  constructor(message: string, outcome: PushFailure) { super(message); this.outcome = outcome }
}
export interface PushResult { message: string; externalId: string | null }

// A thrown fetch is 'unknown' (the request may have reached the CRM before the connection or the timeout ended it)
// unless the error says no connection was ever made.
const NEVER_CONNECTED = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])
async function call(crm: string, f: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try { return await f(url, init) } catch (e) {
    const code = (e as { cause?: { code?: string } })?.cause?.code
    throw code && NEVER_CONNECTED.has(code) ? new CrmPushError(`${crm} could not be reached`, 'failed') : new CrmPushError(`${crm} did not answer; the contact may or may not have been created`, 'unknown')
  }
}
const readJson = async (res: Response): Promise<unknown> => { try { return JSON.parse(await res.text()) } catch { return undefined } }
const obj = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
// A non-2xx answer: a 5xx (or anything we cannot read as a refusal) may hide a created record; a 4xx is a refusal.
const refused = (crm: string, status: number) => status >= 500 || status < 400
  ? new CrmPushError(`${crm} ${status}; the contact may or may not have been created`, 'unknown')
  : new CrmPushError(`${crm} ${status}`, 'failed')
// HubSpot ids are decimal strings; Pipedrive ids are positive integers. Anything else is not a record we can point at.
const hubspotId = (v: unknown) => typeof v === 'string' && /^\d{1,20}$/.test(v) ? v : null
const pipedriveId = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? String(v) : null

// Pushes one lead. Returns what was created (or found) and its record id; throws CrmPushError otherwise.
export async function pushLead(cfg: CrmConfig, lead: CrmLead, fetchImpl?: typeof fetch, deps: { lookup?: Lookup } = {}): Promise<PushResult> {
  const name = lead.name || lead.company
  const f = fetchImpl ?? fetch
  if (cfg.provider === 'hubspot') {
    const [firstname, ...rest] = name.split(' ')
    const auth = { authorization: `Bearer ${cfg.key}` }
    const res = await call('HubSpot', f, 'https://api.hubapi.com/crm/v3/objects/contacts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ properties: { email: lead.contact ?? undefined, firstname, lastname: rest.join(' ') || undefined, company: lead.company, hs_lead_status: 'NEW' } }),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (res.status === 409) {
      // Nothing was created. HubSpot names the contact that holds this email ("Existing ID: 123"); it counts as this
      // lead only when that contact's email is the lead's own. Anything else is a refusal, never "already there".
      const existing = /Existing ID: (\d{1,20})\b/.exec(String(obj(await readJson(res))?.message ?? ''))?.[1]
      const email = (lead.contact ?? '').trim().toLowerCase()
      if (!existing || !email) throw new CrmPushError('HubSpot reported a conflicting contact that could not be matched to this lead', 'failed')
      const got = await call('HubSpot', f, `https://api.hubapi.com/crm/v3/objects/contacts/${existing}?properties=email`, { headers: auth, signal: AbortSignal.timeout(TIMEOUT) })
        .catch(() => null)
      const found = got?.ok ? obj(await readJson(got)) : null
      const foundEmail = obj(found?.properties)?.email
      if (!found || hubspotId(found.id) !== existing || typeof foundEmail !== 'string') throw new CrmPushError('HubSpot reported a conflicting contact that could not be checked', 'failed')
      if (foundEmail.trim().toLowerCase() !== email) throw new CrmPushError('HubSpot reported a conflicting contact that is not this lead', 'failed')
      return { message: 'Already in HubSpot (matching contact exists)', externalId: existing }
    }
    if (!res.ok) throw refused('HubSpot', res.status)
    const id = hubspotId(obj(await readJson(res))?.id)
    if (!id) throw new CrmPushError('HubSpot answered without a contact id; the contact may or may not have been created', 'unknown')
    return { message: 'Contact created in HubSpot', externalId: id }
  }
  if (cfg.provider === 'pipedrive') {
    const res = await call('Pipedrive', f, `https://api.pipedrive.com/v1/persons?api_token=${encodeURIComponent(cfg.key ?? '')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, email: lead.contact ?? undefined, org_name: lead.company }),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (!res.ok) throw refused('Pipedrive', res.status)
    const j = obj(await readJson(res))
    if (j?.success === false) throw new CrmPushError('Pipedrive rejected the contact', 'failed')
    const id = j?.success === true ? pipedriveId(obj(j.data)?.id) : null
    if (!id) throw new CrmPushError('Pipedrive answered without a person id; the person may or may not have been created', 'unknown')
    return { message: 'Person created in Pipedrive', externalId: id }
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
  // The webhook protocol is the tenant's own: any 2xx (a 204 with no body included) is delivery, and no record id is
  // expected. Its errors stay plain failures, as before.
  if ('error' in r) throw new Error(r.error === 'not_public' ? 'Webhook address is not public' : r.status ? `Webhook ${r.status}` : `Webhook ${r.error}`)
  return { message: 'Lead sent to your webhook', externalId: null }
}

// Audit one push attempt on the connectors settings page: ok, worker_error (nothing created), uncertain (unknown: it
// may have been created), or what the user found when resolving an unknown push.
export type PushAudit = 'ok' | 'worker_error' | 'uncertain' | 'resolved_created' | 'resolved_not_created'
export function auditPush(db: Database.Database, tenantId: string, provider: string, lead: { company: string; scan_job_id?: string | null }, status: PushAudit): void {
  audit(db, { tenantId, connector: `crm:${provider}`, jobId: lead.scan_job_id ?? null, lookup: lead.company.slice(0, 200), status, results: status === 'ok' || status === 'resolved_created' ? 1 : 0 })
}

// ---------- push claims (crm_push_claims, lib/connectors/store.ts) ----------
// A native CRM create (HubSpot, Pipedrive) is sent only by the request that claimed (tenant, destination, lead) first.
// The destination is the provider and the account the key opens (a fingerprint of the key, never the key), so a claim
// follows the lead id, not its company text, and another CRM account is another destination. The generic webhook
// keeps its own protocol and takes no claim.
//   pending   a create is (or was) on its way. A claim still pending after STALE_CLAIM_SECONDS belongs to a request
//             that crashed or could not record its result: it is unknown.
//   uncertain the CRM's answer did not say whether the record exists.
//   Both block a new push until the user resolves it (resolveClaim). ok, failed and the resolved states may be claimed
//   again. A claim that could not be finished stays pending, so a failure to record never makes a retry look safe.
export const STALE_CLAIM_SECONDS = 300
export type ClaimBlock = 'in_progress' | 'unknown'
export const crmDestination = (tenantId: string, cfg: CrmConfig): string =>
  `${cfg.provider}:${createHash('sha256').update(`dazl-crm-destination\0${tenantId}\0${cfg.provider}\0${cfg.key ?? ''}`).digest('hex').slice(0, 24)}`
const nowS = () => Math.floor(Date.now() / 1000)

// Claims the push atomically. Returns the claim time (the fence finishClaim needs), or why the lead is blocked.
export function claimPush(db: Database.Database, tenantId: string, destination: string, leadId: string, now = nowS()): { claimedAt: number } | { blocked: ClaimBlock } {
  const r = db.prepare(`INSERT INTO crm_push_claims (tenant_id, destination, lead_id, status, claimed_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)
    ON CONFLICT (tenant_id, destination, lead_id) DO UPDATE SET status = 'pending', external_id = NULL, claimed_at = excluded.claimed_at, updated_at = excluded.updated_at
    WHERE crm_push_claims.status IN ('ok', 'failed', 'resolved_created', 'resolved_not_created')`).run(tenantId, destination, leadId, now, now)
  if (r.changes === 1) return { claimedAt: now }
  const c = db.prepare('SELECT status, claimed_at FROM crm_push_claims WHERE tenant_id = ? AND destination = ? AND lead_id = ?').get(tenantId, destination, leadId) as { status: string; claimed_at: number }
  return { blocked: c.status === 'pending' && c.claimed_at > now - STALE_CLAIM_SECONDS ? 'in_progress' : 'unknown' }
}
// Records the outcome of the claim this request holds. False when the claim is no longer this request's (resolved as
// stale meanwhile); the caller then reports the outcome as unknown.
export function finishClaim(db: Database.Database, tenantId: string, destination: string, leadId: string, claimedAt: number, status: 'ok' | 'failed' | 'uncertain', externalId: string | null, now = nowS()): boolean {
  return db.prepare("UPDATE crm_push_claims SET status = ?, external_id = ?, updated_at = ? WHERE tenant_id = ? AND destination = ? AND lead_id = ? AND status = 'pending' AND claimed_at = ?")
    .run(status, externalId, now, tenantId, destination, leadId, claimedAt).changes === 1
}
// The user checked the CRM after an unknown outcome. Only an unknown claim (uncertain, or pending past the stale
// limit) can be resolved, atomically: a second resolve, or one racing a fresh push, changes nothing.
export function resolveClaim(db: Database.Database, tenantId: string, destination: string, leadId: string, created: boolean, now = nowS()): boolean {
  return db.prepare(`UPDATE crm_push_claims SET status = ?, updated_at = ? WHERE tenant_id = ? AND destination = ? AND lead_id = ?
    AND (status = 'uncertain' OR (status = 'pending' AND claimed_at <= ?))`)
    .run(created ? 'resolved_created' : 'resolved_not_created', now, tenantId, destination, leadId, now - STALE_CLAIM_SECONDS).changes === 1
}
