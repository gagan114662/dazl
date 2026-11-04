// Live-provider acceptance for #569: does a CRM push that dazl reports as created point at a record the provider
// really holds? Run against a SANDBOX CRM account only (scripts/crm-live-acceptance.mts refuses anything else). It
// drives the real pushLead (lib/crm/index.ts) with one synthetic lead, then checks the provider independently:
//   0. account      the key must belong to a sandbox: HubSpot account-info must say DEVELOPER_TEST or SANDBOX;
//                   Pipedrive (no account type) must name the company domain the operator expects. Otherwise
//                   nothing at all is pushed.
//   1. bad_key      a push with a deliberately invalid key is a 'failed' refusal (nothing created, nothing reported)
//   2. create       a push with the sandbox key returns a record id
//   3. read_back    GET that id from the provider: the record exists, with the same id and the lead's email
//   4. duplicate    HubSpot only: pushing the same lead again is the verified 409 path, naming the SAME id.
//                   (Pipedrive has no uniqueness on email, so a second push would create a duplicate: skipped.)
//   5. cleanup      the synthetic record is deleted and a second GET confirms it is gone
// Every step is recorded in the report, pass or fail; a failed step never stops cleanup of a record that was made.
// The key never enters the report. No real person: the lead is "Dazl Acceptance" at a reserved example.com address.
import { pushLead, CrmPushError, type CrmLead } from './index.ts'

export type AcceptanceProvider = 'hubspot' | 'pipedrive'
export type StepName = 'account' | 'bad_key' | 'create' | 'read_back' | 'duplicate' | 'cleanup'
export interface AcceptanceStep { step: StepName; ok: boolean; skipped?: boolean; detail: string }
export interface AcceptanceReport { provider: AcceptanceProvider; runId: string; at: string; lead: { company: string; contact: string }; recordId: string | null; ok: boolean; steps: AcceptanceStep[] }

const TIMEOUT = 10_000
const HUBSPOT = 'https://api.hubapi.com/crm/v3/objects/contacts'
const PIPEDRIVE = 'https://api.pipedrive.com/v1/persons'
const INVALID_KEY = 'dazl-acceptance-invalid-key'

export const acceptanceLead = (runId: string): CrmLead => ({
  company: `Dazl Acceptance ${runId}`,
  name: 'Dazl Acceptance',
  contact: `dazl-acceptance-${runId}@example.com`,
  signal: 'Synthetic live-acceptance record (#569); safe to delete',
  source_url: 'https://dazl.ai/',
})

const obj = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
const json = async (r: Response): Promise<unknown> => { try { return JSON.parse(await r.text()) } catch { return undefined } }
const errText = (e: unknown) => e instanceof CrmPushError ? `${e.outcome}: ${e.message}` : e instanceof Error ? e.message : String(e)

// One provider read of the record, independent of pushLead's own parsing. 'gone' only on a definite not-found
// (or Pipedrive's soft-deleted active_flag false); anything unreadable is 'error', never 'gone' or 'found'.
type Read = { kind: 'found'; id: string; email: string | null } | { kind: 'gone' } | { kind: 'error'; detail: string }
async function readRecord(provider: AcceptanceProvider, key: string, id: string, f: typeof fetch): Promise<Read> {
  let res: Response
  try {
    res = provider === 'hubspot'
      ? await f(`${HUBSPOT}/${encodeURIComponent(id)}?properties=email`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT) })
      : await f(`${PIPEDRIVE}/${encodeURIComponent(id)}?api_token=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(TIMEOUT) })
  } catch (e) { return { kind: 'error', detail: `read failed: ${errText(e)}` } }
  if (res.status === 404 || res.status === 410) return { kind: 'gone' }
  if (!res.ok) return { kind: 'error', detail: `read answered ${res.status}` }
  const j = obj(await json(res))
  if (provider === 'hubspot') {
    const got = typeof j?.id === 'string' ? j.id : null
    const email = obj(j?.properties)?.email
    if (!got) return { kind: 'error', detail: 'read answered without an id' }
    return { kind: 'found', id: got, email: typeof email === 'string' ? email : null }
  }
  const d = obj(j?.data)
  if (j?.success !== true || !d || typeof d.id !== 'number') return { kind: 'error', detail: 'read answered without success and a person id' }
  if (d.active_flag === false) return { kind: 'gone' }
  // Pipedrive persons carry email as [{ value, primary }]
  const emails = Array.isArray(d.email) ? d.email.map(x => obj(x)?.value).filter((v): v is string => typeof v === 'string') : []
  return { kind: 'found', id: String(d.id), email: emails[0] ?? null }
}

async function deleteRecord(provider: AcceptanceProvider, key: string, id: string, f: typeof fetch): Promise<string | null> {
  try {
    const res = provider === 'hubspot'
      ? await f(`${HUBSPOT}/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT) })
      : await f(`${PIPEDRIVE}/${encodeURIComponent(id)}?api_token=${encodeURIComponent(key)}`, { method: 'DELETE', signal: AbortSignal.timeout(TIMEOUT) })
    return res.ok || res.status === 404 ? null : `delete answered ${res.status}`
  } catch (e) { return `delete failed: ${errText(e)}` }
}

// Which account the key opens, read-only. Fails closed: anything unreadable is not a sandbox.
async function sandboxCheck(provider: AcceptanceProvider, key: string, expectDomain: string | undefined, f: typeof fetch): Promise<{ ok: boolean; detail: string }> {
  try {
    if (provider === 'hubspot') {
      const res = await f('https://api.hubapi.com/account-info/v3/details', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT) })
      if (!res.ok) return { ok: false, detail: `account-info answered ${res.status}` }
      const t = obj(await json(res))?.accountType
      return typeof t === 'string' && SANDBOX_TYPES.has(t) ? { ok: true, detail: `HubSpot account type ${t}` } : { ok: false, detail: `HubSpot account type ${typeof t === 'string' ? t : 'unreadable'} is not a sandbox; nothing pushed` }
    }
    if (!expectDomain) return { ok: false, detail: 'Pipedrive has no sandbox flag: set the expected sandbox company domain; nothing pushed' }
    const res = await f(`https://api.pipedrive.com/v1/users/me?api_token=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(TIMEOUT) })
    if (!res.ok) return { ok: false, detail: `users/me answered ${res.status}` }
    const d = obj(obj(await json(res))?.data)?.company_domain
    return typeof d === 'string' && d === expectDomain ? { ok: true, detail: `Pipedrive company ${d}` } : { ok: false, detail: `Pipedrive company ${typeof d === 'string' ? d : 'unreadable'} is not the expected sandbox; nothing pushed` }
  } catch (e) { return { ok: false, detail: `account check failed: ${errText(e)}` } }
}
const SANDBOX_TYPES = new Set(['DEVELOPER_TEST', 'SANDBOX'])

export async function runCrmAcceptance(o: { provider: AcceptanceProvider; key: string; runId: string; expectDomain?: string; fetchImpl?: typeof fetch; now?: Date }): Promise<AcceptanceReport> {
  const f = o.fetchImpl ?? fetch
  const lead = acceptanceLead(o.runId)
  const steps: AcceptanceStep[] = []
  const rec = (step: StepName, ok: boolean, detail: string, skipped = false) => { steps.push(skipped ? { step, ok, skipped, detail } : { step, ok, detail }) }
  // Every detail passes through this: a provider echoing the key in an error message never puts it in the report.
  const clean = (s: string) => o.key ? s.split(o.key).join('[key]') : s

  const report = (id: string | null): AcceptanceReport => ({ provider: o.provider, runId: o.runId, at: (o.now ?? new Date()).toISOString(), lead: { company: lead.company, contact: lead.contact ?? '' }, recordId: id, ok: steps.every(s => s.ok), steps })

  // 0. a sandbox, or nothing is sent
  const acct = await sandboxCheck(o.provider, o.key, o.expectDomain, f)
  rec('account', acct.ok, clean(acct.detail))
  if (!acct.ok) return report(null)

  // 1. an invalid key must be a definite refusal
  try {
    const r = await pushLead({ provider: o.provider, key: INVALID_KEY }, lead, f)
    rec('bad_key', false, clean(`an invalid key was reported as success (${r.message}, id ${r.externalId})`))
  } catch (e) {
    rec('bad_key', e instanceof CrmPushError && e.outcome === 'failed', clean(errText(e)))
  }

  // 2. create
  let id: string | null = null
  try {
    const r = await pushLead({ provider: o.provider, key: o.key }, lead, f)
    id = r.externalId
    rec('create', !!id, clean(`${r.message}; id ${id ?? 'none'}`))
  } catch (e) { rec('create', false, clean(errText(e))) }

  if (id) {
    // 3. the provider holds that record, with the lead's email
    const got = await readRecord(o.provider, o.key, id, f)
    const want = (lead.contact ?? '').toLowerCase()
    rec('read_back', got.kind === 'found' && got.id === id && (got.email ?? '').toLowerCase() === want,
      clean(got.kind === 'found' ? `record ${got.id}, email ${got.email === null ? 'missing' : got.email.toLowerCase() === want ? 'matches' : 'differs'}` : got.kind === 'gone' ? 'the provider has no record with that id' : got.detail))
    // 4. HubSpot: the same lead again is the verified 409 naming the same record
    if (o.provider === 'hubspot') {
      try {
        const r = await pushLead({ provider: o.provider, key: o.key }, lead, f)
        rec('duplicate', r.externalId === id && /^Already in HubSpot/.test(r.message), clean(`${r.message}; id ${r.externalId}`))
      } catch (e) { rec('duplicate', false, clean(errText(e))) }
    } else rec('duplicate', true, 'Pipedrive has no unique email: a second push would create a duplicate, so it is not sent', true)
    // 5. cleanup, then confirm it is gone
    const del = await deleteRecord(o.provider, o.key, id, f)
    const after = del ? null : await readRecord(o.provider, o.key, id, f)
    rec('cleanup', !del && after?.kind === 'gone', clean(del ?? (after?.kind === 'gone' ? `record ${id} deleted` : `record ${id} still readable after delete (${after?.kind === 'error' ? after.detail : 'found'}); delete it by hand`)))
  } else {
    rec('read_back', false, 'no record id to read', true)
    rec('duplicate', false, 'no record id', true)
    rec('cleanup', true, 'nothing was reported created; check the sandbox for a stray "Dazl Acceptance" record if create was unknown', true)
  }
  return report(id)
}
