// #390: consent-aware first-party demand signals. The tenant's OWN website forms, demo requests and (optionally) company-level
// visits/product events, posted server-to-server to a per-tenant signed endpoint (app/api/hooks/first-party). Nothing here
// installs a tracker, sets a cookie, looks up an IP or calls any third party: an event says only what the tenant's own systems
// already know, and dazl never resolves a visitor to a company or a person.
//
// Storage, no schema change (the tech_scan precedent in tech-observations.ts):
//   - config: one tenant_connectors row, connector 'first_party' (encrypted JSON: signing secret, site domain, recorded consent
//     basis, privacy notice URL, retention days, who recorded it and when). enabled = 0 is the tenant's opt-out: collection stops.
//     Every config change is also a connector_audit row (the recorded basis, when).
//   - leads: source_kind 'first_party', review_reason 'first_party_signal', dedup_key 'fp:a:<domain>' (account) or
//     'fp:p:<hash of email>' (the person who submitted a form). The email itself is never stored: not as the lead's contact (a
//     form address is not a published address, docs/DECISIONS.md), not in any row.
//   - dated signals: one lead_enrichments row per accepted event, connector 'first_party', kind 'first_party_event', value
//     '<type>:<event hash>' (the dedup/replay key), source_url = the tenant's own page (query/fragment stripped), source_date = the
//     event day, label = identity basis + consent basis + receipt digest of the signed request (the proof).
//
// Rules this module keeps (fail closed):
//   - No recorded config, or collection off: nothing is read or stored.
//   - Each event must carry consent 'granted'; anything else (denied, missing, withdrawn, a GPC/DNT opt-out) is not stored. A
//     withdrawn form subject's earlier first-party lead is erased.
//   - Account-level events (site_visit, product_event) never carry a person: an event that names one is rejected, and an account
//     lead never names a person. Employees at a visiting company are not the visitor.
//   - Account identity only from the tenant's own first-party basis (signed-in product account, or the visitor identified
//     themselves earlier). Anything else - reverse IP, enrichment, a third party - stays unknown, as does residential, VPN,
//     mobile, proxy or Tor traffic and any consumer mail domain. Unknown events are counted, never stored.
//   - The tenant's own domain is internal traffic, never a lead. Pages must be on the recorded site domain.
//   - Replay: the signature covers a timestamp that must be within REPLAY_WINDOW_S, and each event id is stored once per tenant.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Db, Tx, TxBody } from '../db/client.ts'
import { decryptSecret, encryptSecret } from '../secrets.ts'
import { CONSUMER_DOMAINS } from '../billing/trial-budget.ts'
import { FP_TYPE_LABEL } from './first-party-labels.ts'

export const FP_CONNECTOR = 'first_party'
export const FP_EVENT_KIND = 'first_party_event'
export const FP_SOURCE_KIND = 'first_party'
export const FP_REVIEW_REASON = 'first_party_signal'
export const FP_POLICY_VERSION = 'fp-v1'
export const REPLAY_WINDOW_S = 300
export const MAX_EVENTS = 50
export const MAX_BODY = 64_000
export const RETENTION_MIN_DAYS = 30
export const RETENTION_MAX_DAYS = 730
export const FP_EVENT_TYPES = ['form_submission', 'demo_request', 'site_visit', 'product_event'] as const
export type FpEventType = (typeof FP_EVENT_TYPES)[number]
// The lawful basis a tenant can record today. Only opt-in consent: anything else (legitimate interest) is an owner decision.
// Deployment gate (#390): first-party collection is available only when this process was explicitly started with
// DAZL_FIRST_PARTY_ENABLED=1 - the exact literal; '0', 'true', '', ' 1' and unset are all OFF. Read per request,
// never cached at import, so a test or a process manager change is seen immediately. OFF, the public hook answers
// exactly like an unknown tenant and the settings route refuses record/enable; disable, erase, status and the
// retention purge keep working regardless (privacy cleanup never depends on the gate).
export const firstPartyAvailable = (): boolean => process.env.DAZL_FIRST_PARTY_ENABLED === '1'

export const FP_BASES = ['consent'] as const
export type FpBasis = (typeof FP_BASES)[number]
// First-party ways an account can be known. A product sign-in, or the visitor identified themselves to the tenant earlier.
export const ACCOUNT_BASES = ['logged_in_account', 'self_identified'] as const
export type AccountBasis = (typeof ACCOUNT_BASES)[number]
// Traffic that cannot be tied to a company at all: always unknown, whatever else the event says.
export const UNRESOLVABLE_NETWORKS = new Set(['residential', 'vpn', 'mobile', 'proxy', 'tor'])
// Identity confidence per basis (0-100). Product heuristics, not measured accuracy: a self-submitted form is the person's own
// statement (not mailbox-verified); a signed-in account is the account, not the person; an earlier self-identification is older.
export const IDENTITY_CONFIDENCE = { self_submitted: 80, logged_in_account: 70, self_identified: 50 } as const
export type IdentityBasis = keyof typeof IDENTITY_CONFIDENCE
const TYPE_LABEL = FP_TYPE_LABEL as Record<FpEventType, string>
const JOB_MARK = 'first_party' // industry and location of the scan jobs that hold first-party leads

export interface FpConfig { v: 1; secret: string; site_domain: string; basis: FpBasis; privacy_url: string; retention_days: number; recorded_at: number; recorded_by: string; policy: string; accept_floor?: number }
export interface FpConfigInput { site_domain: string; basis: FpBasis; privacy_url: string; retention_days: number }

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})$/
const CTRL = /[\u0000-\u001f\u007f]/
export const normDomain = (d: string): string => d.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
export const isSiteDomain = (d: string): boolean => d.length <= 120 && DOMAIN_RE.test(d) && !/^\d+(\.\d+)+$/.test(d)
const onDomain = (host: string, site: string): boolean => { const h = normDomain(host); return h === site || h.endsWith(`.${site}`) }
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
export const day = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString().slice(0, 10)
const ctx = (tenantId: string) => `connector:${tenantId}:${FP_CONNECTOR}`

// ---- config ---------------------------------------------------------------------------------------------------------------

// The tenant's recorded choice. Returns an error message (shown to the user) or the clean input.
export function parseConfigInput(raw: unknown): FpConfigInput | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Add your site domain, consent basis, privacy notice URL and retention period.' }
  const r = raw as Record<string, unknown>
  const site = typeof r.site_domain === 'string' ? normDomain(r.site_domain) : ''
  if (!isSiteDomain(site)) return { error: 'Use your own site domain, for example example.com.' }
  if (!FP_BASES.includes(r.basis as FpBasis)) return { error: 'Record the consent basis: only opt-in consent ("consent") is supported.' }
  let privacy = ''
  try {
    const u = new URL(typeof r.privacy_url === 'string' ? r.privacy_url : '')
    if (u.protocol !== 'https:' || u.username || u.password || !onDomain(u.hostname, site)) throw new Error()
    privacy = `${u.origin}${u.pathname}`.slice(0, 300)
  } catch { return { error: 'Use the HTTPS URL of your privacy notice on your site domain.' } }
  const days = r.retention_days
  if (typeof days !== 'number' || !Number.isInteger(days) || days < RETENTION_MIN_DAYS || days > RETENTION_MAX_DAYS) return { error: `Keep first-party events ${RETENTION_MIN_DAYS}-${RETENTION_MAX_DAYS} days.` }
  return { site_domain: site, basis: r.basis as FpBasis, privacy_url: privacy, retention_days: days }
}

const AUDIT_SQL = 'INSERT INTO connector_audit (id, tenant_id, connector, scan_job_id, lookup, status, results) VALUES (?, ?, ?, ?, ?, ?, ?)'
const auditRow = (tenantId: string, lookup: string, status: string, results: number, jobId: string | null = null) =>
  [randomBytes(12).toString('hex'), tenantId, FP_CONNECTOR, jobId, lookup.slice(0, 200), status, results]

// Advisory lock keys (Postgres; SQLite transactions are synchronous so they are skipped there). Ordering rule
// everywhere: fp_config first, then the sorted fp_withdraw person keys - no cycle is possible.
const FP_CONFIG_LOCK = 'fp_config:'
function* lockConfig(t: Tx, tenantId: string, exclusive: boolean): TxBody<void> {
  if (t.kind !== 'pg') return
  if (exclusive) yield* t.get("SELECT pg_advisory_xact_lock(hashtextextended(? || ?, 0)) AS x", [FP_CONFIG_LOCK, tenantId])
  else yield* t.get("SELECT pg_advisory_xact_lock_shared(hashtextextended(? || ?, 0)) AS x", [FP_CONFIG_LOCK, tenantId])
}

// The tenant's config read inside a transaction (fresh under concurrent re-records).
function* readConfigTx(t: Tx, tenantId: string, master?: Buffer): TxBody<{ config: FpConfig; enabled: boolean } | null> {
  const r = yield* t.get<{ ciphertext: string; enabled: number }>('SELECT ciphertext, enabled FROM tenant_connectors WHERE tenant_id = ? AND connector = ?', [tenantId, FP_CONNECTOR])
  if (!r?.ciphertext) return null
  try {
    const c = JSON.parse(decryptSecret(r.ciphertext, ctx(tenantId), master)) as FpConfig
    if (!validConfig(c)) return null
    return { config: c, enabled: Number(r.enabled) === 1 }
  } catch { return null }
}

function validConfig(c: FpConfig): boolean {
  if (c?.v !== 1 || typeof c.secret !== 'string' || !isSiteDomain(c.site_domain) || !FP_BASES.includes(c.basis)) return false
  if (c.accept_floor !== undefined && !(typeof c.accept_floor === 'number' && Number.isInteger(c.accept_floor) && c.accept_floor > 0)) return false
  return true
}

// Records (or replaces) the tenant's config with a NEW signing secret, collection on. The secret is returned once.
export async function recordConfig(db: Db, tenantId: string, input: FpConfigInput, actorId: string, now = Math.floor(Date.now() / 1000), master?: Buffer): Promise<string> {
  const secret = randomBytes(32).toString('base64url')
  return db.tx(function* (t) {
    // The previous config is read INSIDE the transaction, behind the per-tenant advisory lock on Postgres (SQLite
    // runs the whole tx synchronously): two racing re-records serialize, so the monotonic acceptance floor cannot be
    // overwritten by the smaller candidate, whatever the commit order or clock skew.
    yield* lockConfig(t, tenantId, true)
    // Prospective acceptance: events already expired under the PREVIOUS recorded period stay expired (floor moves only forward).
    const prevRow = yield* t.get<{ ciphertext: string }>('SELECT ciphertext FROM tenant_connectors WHERE tenant_id = ? AND connector = ?', [tenantId, FP_CONNECTOR])
    let prev: FpConfig | null = null
    if (prevRow?.ciphertext) {
      // FAIL CLOSED: an existing row that cannot be decrypted and validated (corrupt, wrong key, invalid floor) is
      // NOT "no config" - overwriting it would reset the acceptance floor and reopen expired windows. Refuse; the
      // transaction writes nothing. Only a genuinely absent row records fresh.
      try {
        const c = JSON.parse(decryptSecret(prevRow.ciphertext, ctx(tenantId), master)) as FpConfig
        if (!validConfig(c)) throw new Error('invalid')
        prev = c
      } catch { throw new Error('first-party config exists but is unreadable; refusing to overwrite (fail closed)') }
    }
    // Floor base is the LATEST retention clock: this re-record's own now and any purge tick that already enforced
    // the previous period (a purge whose clock was ahead deleted tombstones/events up to its own cutoff).
    const lastPurge = (yield* t.get<{ last_purge_at: number | null }>('SELECT last_purge_at FROM first_party_config_meta WHERE tenant_id = ?', [tenantId]))?.last_purge_at ?? 0
    const floor = Math.max(prev?.accept_floor ?? 0, prev ? Math.max(now, lastPurge) - prev.retention_days * 86400 : 0)
    const cfg: FpConfig = { v: 1, secret, ...input, recorded_at: now, recorded_by: actorId.slice(0, 80), policy: FP_POLICY_VERSION, ...(floor > 0 ? { accept_floor: floor } : {}) }
    const blob = encryptSecret(JSON.stringify(cfg), ctx(tenantId), master)
    yield* t.run(`INSERT INTO tenant_connectors (tenant_id, connector, ciphertext, last4, enabled) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT (tenant_id, connector) DO UPDATE SET ciphertext = excluded.ciphertext, last4 = excluded.last4, enabled = 1`, [tenantId, FP_CONNECTOR, blob, secret.slice(-4)])
    yield* t.run('INSERT INTO first_party_config_meta (tenant_id, retention_days, recorded_at) VALUES (?, ?, ?) ON CONFLICT (tenant_id) DO UPDATE SET retention_days = excluded.retention_days, recorded_at = excluded.recorded_at', [tenantId, input.retention_days, now])
    yield* t.run(AUDIT_SQL, auditRow(tenantId, `config:${FP_POLICY_VERSION};basis=${input.basis};domain=${input.site_domain};retention=${input.retention_days}d;privacy=${input.privacy_url}`, 'recorded', 0))
    return secret
  })
}

export async function readConfig(db: Db, tenantId: string, master?: Buffer): Promise<{ config: FpConfig; enabled: boolean } | null> {
  const r = await db.get<{ ciphertext: string; enabled: number }>('SELECT ciphertext, enabled FROM tenant_connectors WHERE tenant_id = ? AND connector = ?', [tenantId, FP_CONNECTOR])
  if (!r?.ciphertext) return null
  try {
    const c = JSON.parse(decryptSecret(r.ciphertext, ctx(tenantId), master)) as FpConfig
    if (!validConfig(c)) return null
    return { config: c, enabled: Number(r.enabled) === 1 }
  } catch { return null } // unreadable config collects nothing
}

// Opt-out / opt back in. Turning collection off keeps stored events until their retention ends or the tenant erases them.
export async function setCollection(db: Db, tenantId: string, on: boolean): Promise<boolean> {
  return db.tx(function* (t) {
    yield* lockConfig(t, tenantId, true)
    const r = yield* t.run('UPDATE tenant_connectors SET enabled = ? WHERE tenant_id = ? AND connector = ? AND enabled <> ?', [on ? 1 : 0, tenantId, FP_CONNECTOR, on ? 1 : 0])
    if (r.changes === 1) yield* t.run(AUDIT_SQL, auditRow(tenantId, `collection:${on ? 'on' : 'off'}`, on ? 'enabled' : 'disabled', 0))
    return r.changes === 1
  })
}

// Status safe for any member: never the secret.
export async function configStatus(db: Db, tenantId: string, master?: Buffer) {
  const c = await readConfig(db, tenantId, master)
  const counts = await db.get<{ leads: number; events: number }>(`SELECT
      (SELECT COUNT(*) FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? AND l.source_kind = ?) AS leads,
      (SELECT COUNT(*) FROM lead_enrichments WHERE tenant_id = ? AND connector = ? AND kind = ?) AS events`, [tenantId, FP_SOURCE_KIND, tenantId, FP_CONNECTOR, FP_EVENT_KIND])
  return {
    configured: !!c, collecting: !!c?.enabled,
    site_domain: c?.config.site_domain ?? null, basis: c?.config.basis ?? null, privacy_url: c?.config.privacy_url ?? null,
    retention_days: c?.config.retention_days ?? null, recorded_at: c?.config.recorded_at ?? null, policy: c?.config.policy ?? null,
    secret_last4: c ? c.config.secret.slice(-4) : null,
    stored: { leads: Number(counts?.leads ?? 0), events: Number(counts?.events ?? 0) },
  }
}

// ---- signature ------------------------------------------------------------------------------------------------------------

// X-Dazl-Signature: hex HMAC-SHA256(secret, `${X-Dazl-Timestamp}.${raw body}`). The timestamp is unix seconds.
export function signBody(secret: string, timestamp: number | string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')
}
export function verifyRequest(secret: string, tsHeader: string | null, sigHeader: string | null, rawBody: string, now = Math.floor(Date.now() / 1000)): 'ok' | 'bad_signature' | 'stale' {
  if (!tsHeader || !/^\d{9,11}$/.test(tsHeader) || !sigHeader || !/^[a-f0-9]{64}$/i.test(sigHeader)) return 'bad_signature'
  const want = Buffer.from(signBody(secret, tsHeader, rawBody), 'hex'), got = Buffer.from(sigHeader, 'hex')
  if (want.length !== got.length || !timingSafeEqual(want, got)) return 'bad_signature'
  return Math.abs(now - Number(tsHeader)) <= REPLAY_WINDOW_S ? 'ok' : 'stale'
}

// ---- withdrawal tombstones ------------------------------------------------------------------------------------------------

// A consent withdrawal is REMEMBERED: erasing the subject's leads is not enough, because an older-dated granted event
// that arrives after the withdrawal (a retry, a delayed queue, a backfill) would recreate the lead. The tombstone is
// the minimum that prevents resurrection: the tenant-namespaced fp:p: hash and the withdrawal time. Never the email,
// never a name.
//
// Privacy facts, stated plainly: person_key is sha256(tenantId|email) truncated - a deterministic tenant-namespaced
// hash (NOT keyed: the tenant id is public, no secret enters the derivation). Anyone who knows the tenant id and
// guesses the email can verify the pair by hashing, so the tombstone is pseudonymous personal data, still personal
// data, and is treated as such: it lives at most the tenant's recorded retention period (purged in the
// same tick as the events), is removed by eraseFirstParty and tenant deletion, and is justified only as the minimum
// record needed to honor the withdrawal the consent flow already promised. Retention interaction that makes the bound
// sound: a grant older than retention_days is rejected:bad_time, so once a tombstone has aged out, every grant dated
// at/before the withdrawal is too old to be accepted anyway - expiry cannot reopen resurrection. The one boundary to
// name: a FULL erase (eraseFirstParty or tenant deletion) forgets the withdrawal with everything else, so a grant
// replayed after the tenant re-records a config is evaluated against the new config alone. That is the existing erase
// semantics, unchanged.
//
// A grant dated AFTER the withdrawal is a new consent and is allowed.
export const FP_WITHDRAWALS_DDL = `
  CREATE TABLE IF NOT EXISTS first_party_withdrawals (
    tenant_id    TEXT NOT NULL,
    person_key   TEXT NOT NULL,
    withdrawn_at INTEGER NOT NULL,
    recorded_at  INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, person_key)
  );
  -- Plaintext retention metadata, written in the same transaction as every config record: when the encrypted config
  -- cannot be read (corrupt, wrong key), the retention tick still has a BOUNDED period to enforce - the last recorded
  -- one - instead of skipping the tenant and letting events and tombstones live until erase. No secret material here.
  CREATE TABLE IF NOT EXISTS first_party_config_meta (
    tenant_id      TEXT PRIMARY KEY,
    retention_days INTEGER NOT NULL,
    recorded_at    INTEGER NOT NULL,
    last_purge_at  INTEGER
  );
`
export function migrateFirstParty(db: import('better-sqlite3').Database): void { db.exec(FP_WITHDRAWALS_DDL) }

// ---- events ---------------------------------------------------------------------------------------------------------------

export type Outcome = 'created' | 'attached' | 'duplicate' | 'unknown' | 'not_consented' | 'withdrawn' | `rejected:${string}`
interface Accepted {
  type: FpEventType; eventKey: string; at: number; pageUrl: string; path: string; label: string | null
  identity: IdentityBasis; dedupKey: string; name: string; company: string; companyDomain: string | null
}

const text = (v: unknown, max: number): string | null => typeof v === 'string' && v.trim() && v.length <= max && !CTRL.test(v) ? v.trim() : null
function eventTime(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) { const ms = Date.parse(v); return Number.isFinite(ms) ? Math.floor(ms / 1000) : null }
  return null
}

// One event against the tenant's config. Pure: no db. `tenantId` namespaces the hashes (deterministic, no secret), so equal emails hash differently per tenant.
export function classifyEvent(raw: unknown, cfg: FpConfig, tenantId: string, now: number): { outcome: Outcome; event?: Accepted; withdrawnKey?: string; withdrawnAt?: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { outcome: 'rejected:malformed' }
  const e = raw as Record<string, unknown>
  const id = text(e.id, 128)
  if (!id) return { outcome: 'rejected:no_event_id' }
  if (!FP_EVENT_TYPES.includes(e.type as FpEventType)) return { outcome: 'rejected:unknown_type' }
  const type = e.type as FpEventType
  const personal = type === 'form_submission' || type === 'demo_request'
  const person = e.person && typeof e.person === 'object' && !Array.isArray(e.person) ? e.person as Record<string, unknown> : null
  const email = person && typeof person.email === 'string' ? person.email.trim().toLowerCase() : ''
  const personKey = (m: string) => `fp:p:${sha(`${tenantId}|${m}`).slice(0, 40)}`
  // Consent first: nothing but an explicit grant is collected, and an opt-out signal overrides a grant.
  if (e.consent === 'withdrawn') return { outcome: 'withdrawn', ...(personal && EMAIL_RE.test(email) ? { withdrawnKey: personKey(email), withdrawnAt: Math.min(eventTime(e.occurred_at) ?? now, now) } : {}) } // clamped: a claimed future withdrawal cannot block or persist past now
  if (e.consent !== 'granted' || e.opt_out === true || e.gpc === true || e.dnt === true) return { outcome: 'not_consented' }
  const at = eventTime(e.occurred_at)
  // accept_floor: retention changes are prospective. An event already expired under the period in force when a
  // re-config was recorded stays expired even if the period is later raised - so a raise can never reopen a window
  // in which a withdrawal tombstone has already aged out (non-resurrection holds across config changes).
  if (at === null || at > now + REPLAY_WINDOW_S || at < now - cfg.retention_days * 86400 || (cfg.accept_floor !== undefined && at < cfg.accept_floor)) return { outcome: 'rejected:bad_time' }
  let page: URL
  try { page = new URL(typeof e.page_url === 'string' ? e.page_url : '') } catch { return { outcome: 'rejected:bad_page_url' } }
  if (page.protocol !== 'https:' || page.username || page.password || !onDomain(page.hostname, cfg.site_domain)) return { outcome: 'rejected:off_domain' }
  const pageUrl = `${page.origin}${page.pathname}`.slice(0, 500) // no query or fragment: they can carry ids or emails
  const path = page.pathname.slice(0, 80) || '/'
  const label = text(e.label, 80)
  const eventKey = `${type}:${sha(`${tenantId}|${id}`).slice(0, 40)}`
  const base = { type, eventKey, at, pageUrl, path, label }
  if (personal) {
    const m = EMAIL_RE.exec(email)
    if (!m) return { outcome: 'rejected:no_submitter_email' }
    const domain = normDomain(m[1])
    if (onDomain(domain, cfg.site_domain)) return { outcome: 'rejected:internal' }
    const consumer = CONSUMER_DOMAINS.has(domain)
    const name = text(person?.name, 150) ?? ''
    const company = text(person?.company, 150) ?? (consumer ? '' : domain)
    if (!name && !company) return { outcome: 'unknown' }
    return { outcome: 'created', event: { ...base, identity: 'self_submitted', dedupKey: personKey(email), name, company, companyDomain: consumer ? null : domain } }
  }
  // Account-level: a person on it is a contract violation, not something to drop quietly.
  if (person || e.email !== undefined || e.name !== undefined) return { outcome: 'rejected:person_on_account_event' }
  if (typeof e.network === 'string' && UNRESOLVABLE_NETWORKS.has(e.network)) return { outcome: 'unknown' }
  const acct = e.account && typeof e.account === 'object' && !Array.isArray(e.account) ? e.account as Record<string, unknown> : null
  if (!acct || !ACCOUNT_BASES.includes(acct.basis as AccountBasis)) return { outcome: 'unknown' } // reverse IP, enrichment, a guess: unknown
  const domain = typeof acct.domain === 'string' ? normDomain(acct.domain) : ''
  if (!isSiteDomain(domain) || CONSUMER_DOMAINS.has(domain)) return { outcome: 'unknown' }
  if (onDomain(domain, cfg.site_domain)) return { outcome: 'rejected:internal' }
  return { outcome: 'created', event: { ...base, identity: acct.basis as AccountBasis, dedupKey: `fp:a:${domain}`, name: '', company: text(acct.name, 150) ?? domain, companyDomain: domain } }
}

function signalText(e: Accepted): string {
  const when = day(e.at), what = e.label ? ` (${e.label})` : ''
  if (e.identity === 'self_submitted') return `${TYPE_LABEL[e.type]} on your site at ${e.path}${what} on ${when}, submitted by the person themself with consent recorded. Buying need and outreach consent are not verified.`.slice(0, 500)
  const basis = e.identity === 'logged_in_account' ? 'a signed-in account' : 'an earlier self-identification'
  return `Account-level ${e.type === 'site_visit' ? 'visit to' : 'product activity on'} ${e.path}${what} on ${when} from ${e.companyDomain} (${basis}). The visitor is not identified: this does not say any named person at ${e.companyDomain} visited.`.slice(0, 500)
}

const FP_LEADS_SQL = 'SELECT l.id FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? AND l.source_kind = ?'

function* eraseLeads(t: Tx, tenantId: string, where: string, params: (string | number)[]): TxBody<number> {
  const ids = (yield* t.all<{ id: string }>(`${FP_LEADS_SQL} ${where}`, [tenantId, FP_SOURCE_KIND, ...params])).map(r => r.id)
  for (const id of ids) {
    yield* t.run('DELETE FROM lead_enrichments WHERE tenant_id = ? AND lead_id = ?', [tenantId, id])
    yield* t.run('DELETE FROM work_email_lookups WHERE tenant_id = ? AND lead_id = ?', [tenantId, id]) // #1036: a found address goes with its lead
    // #1036: published / guessed addresses the crawl recorded for this lead's people (now recorded in prod too) go with it
    yield* t.run('DELETE FROM email_candidates WHERE tenant_id = ? AND lead_id = ?', [tenantId, id])
    yield* t.run('DELETE FROM email_patterns WHERE tenant_id = ? AND lead_id = ?', [tenantId, id])
    yield* t.run('DELETE FROM leads WHERE id = ?', [id])
  }
  // First-party holder jobs left with no leads go too (they only ever held first-party leads).
  if (ids.length) yield* t.run(`DELETE FROM scan_jobs WHERE user_id = ? AND industry = ? AND location = ? AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.scan_job_id = scan_jobs.id)`, [tenantId, JOB_MARK, JOB_MARK])
  return ids.length
}

// Retention: events older than the tenant's recorded period are deleted, then first-party leads left without any event.
// Every enforcement stamps the sidecar's last_purge_at: a later re-record bases its acceptance floor on the latest
// purge clock, not only on its own, so a purge whose clock ran ahead of the re-record cannot leave a floor gap.
function* purgeTx(t: Tx, tenantId: string, retentionDays: number, now: number): TxBody<number> {
  const cutoff = day(now - retentionDays * 86400)
  yield* t.run('UPDATE first_party_config_meta SET last_purge_at = CASE WHEN last_purge_at IS NULL OR last_purge_at < ? THEN ? ELSE last_purge_at END WHERE tenant_id = ?', [now, now, tenantId])
  yield* t.run('DELETE FROM first_party_withdrawals WHERE tenant_id = ? AND withdrawn_at < ?', [tenantId, now - retentionDays * 86400])
  const gone = (yield* t.run('DELETE FROM lead_enrichments WHERE tenant_id = ? AND connector = ? AND kind = ? AND source_date < ?', [tenantId, FP_CONNECTOR, FP_EVENT_KIND, cutoff])).changes
  yield* eraseLeads(t, tenantId, 'AND NOT EXISTS (SELECT 1 FROM lead_enrichments e WHERE e.lead_id = l.id AND e.tenant_id = ? AND e.connector = ? AND e.kind = ?)', [tenantId, FP_CONNECTOR, FP_EVENT_KIND])
  return gone
}

export interface IngestResult { status: 'ok' | 'off' | 'not_configured' | 'bad_body' | 'unauthenticated'; results: { index: number; outcome: Outcome }[]; counts: Record<string, number> }

// The signed request's own headers, so ingest can re-authenticate it against the config it actually ingests under (#921).
export interface FpAuth { timestamp: string | null; signature: string | null }

// Ingest one request body for the tenant. With `auth` (the hook route), the request is re-verified INSIDE the transaction,
// behind the config lock, against the exact config that classifies and retains it: the timestamp, the raw bytes and the
// secret are bound together, so a request authenticated under a secret that a re-record/erase replaced between the
// route's check and this lock is refused ('unauthenticated'), never stored under the replacement config (#921). A bare
// string receipt is the legacy caller-asserted form (the caller already verified with this config's secret).
export async function ingest(db: Db, tenantId: string, rawBody: string, receipt: string | FpAuth, now = Math.floor(Date.now() / 1000), master?: Buffer): Promise<IngestResult> {
  const auth = typeof receipt === 'string' ? null : receipt
  receipt = typeof receipt === 'string' ? receipt : (receipt.signature ?? '')
  const empty = (status: IngestResult['status']): IngestResult => ({ status, results: [], counts: {} })
  let body: { events?: unknown }
  try { body = JSON.parse(rawBody) } catch { return empty('bad_body') }
  if (!body || !Array.isArray(body.events) || body.events.length === 0 || body.events.length > MAX_EVENTS) return empty('bad_body')
  const events: unknown[] = body.events
  const digest = sha(receipt).slice(0, 16)
  return db.tx(function* (t) {
    // The config is read INSIDE the transaction behind a shared config lock: a concurrent re-record (a new secret, a
    // retention change, a new acceptance floor) either lands entirely before this ingest or waits for it - no batch
    // is classified or purged against a config that is mid-replacement. Lock order: fp_config, then the sorted
    // fp_withdraw person keys below.
    yield* lockConfig(t, tenantId, false)
    const c = yield* readConfigTx(t, tenantId, master)
    if (!c) return empty('not_configured')
    // Checked before 'off' so a stale secret learns nothing about the replacement config's state.
    if (auth && verifyRequest(c.config.secret, auth.timestamp, auth.signature, rawBody, now) !== 'ok') return empty('unauthenticated')
    if (!c.enabled) return empty('off')
    const cfg = c.config
    const classified = events.map(e => classifyEvent(e, cfg, tenantId, now))
    // Per-event results start from the classification; the transaction refines created -> attached / duplicate.
    const results = classified.map((k, index) => ({ index, outcome: k.outcome }))
    yield* purgeTx(t, tenantId, cfg.retention_days, now)
    // Deadlock-free locking (Postgres): every key this batch will touch, acquired once up front in deterministic
    // sorted order - a withdrawal takes the exclusive lock, a grant the shared one, a key used by both takes the
    // exclusive. Two concurrent batches over the same people then serialize instead of meeting mid-loop A,B vs B,A.
    if (t.kind === 'pg') {
      const mode = new Map<string, 'x' | 's'>()
      for (const k of classified) {
        if (k.withdrawnKey) mode.set(k.withdrawnKey, 'x')
        else if (k.event?.dedupKey.startsWith('fp:p:') && !mode.has(k.event.dedupKey)) mode.set(k.event.dedupKey, 's')
      }
      for (const key of [...mode.keys()].sort()) {
        if (mode.get(key) === 'x') yield* t.get("SELECT pg_advisory_xact_lock(hashtextextended('fp_withdraw:' || ? || ':' || ?, 0)) AS x", [tenantId, key])
        else yield* t.get("SELECT pg_advisory_xact_lock_shared(hashtextextended('fp_withdraw:' || ? || ':' || ?, 0)) AS x", [tenantId, key])
      }
    }
    let jobId: string | null = null
    for (let i = 0; i < classified.length; i++) {
      const k = classified[i]
      if (k.withdrawnKey) {
        // Remember the withdrawal (latest one wins), then erase.
        yield* t.run(`INSERT INTO first_party_withdrawals (tenant_id, person_key, withdrawn_at, recorded_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (tenant_id, person_key) DO UPDATE SET withdrawn_at = CASE WHEN excluded.withdrawn_at > first_party_withdrawals.withdrawn_at THEN excluded.withdrawn_at ELSE first_party_withdrawals.withdrawn_at END, recorded_at = CASE WHEN excluded.withdrawn_at > first_party_withdrawals.withdrawn_at THEN excluded.recorded_at ELSE first_party_withdrawals.recorded_at END`,
          [tenantId, k.withdrawnKey, k.withdrawnAt ?? now, now])
        yield* eraseLeads(t, tenantId, 'AND l.dedup_key = ?', [k.withdrawnKey])
      }
      if (!k.event) continue
      const e = k.event
      if (e.dedupKey.startsWith('fp:p:')) {
        // A grant for a tombstoned person dated at/before the withdrawal is a late retry, not a consent.
        const tomb = yield* t.get<{ withdrawn_at: number }>('SELECT withdrawn_at FROM first_party_withdrawals WHERE tenant_id = ? AND person_key = ?', [tenantId, e.dedupKey])
        if (tomb && e.at <= Number(tomb.withdrawn_at)) { results[i].outcome = 'not_consented'; continue }
      }
      const dup = yield* t.get('SELECT 1 AS x FROM lead_enrichments WHERE tenant_id = ? AND connector = ? AND kind = ? AND value = ?', [tenantId, FP_CONNECTOR, FP_EVENT_KIND, e.eventKey])
      if (dup) { results[i].outcome = 'duplicate'; continue }
      const existing = yield* t.get<{ id: string }>(`${FP_LEADS_SQL} AND l.dedup_key = ? ORDER BY l.created_at LIMIT 1`, [tenantId, FP_SOURCE_KIND, e.dedupKey])
      let leadId = existing?.id
      if (leadId) {
        results[i].outcome = 'attached'
        yield* t.run('UPDATE leads SET event_date = ? WHERE id = ? AND (event_date IS NULL OR event_date < ?)', [day(e.at), leadId, day(e.at)])
      } else {
        if (!jobId) {
          jobId = randomBytes(12).toString('hex')
          yield* t.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'First-party signals', ?, ?, 'running')", [jobId, tenantId, JOB_MARK, JOB_MARK])
        }
        leadId = randomBytes(12).toString('hex')
        yield* t.run(`INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, event_date, date_status, retrieved_at, confidence, dedup_key, review_reason, source_kind, company_domain, timing_note)
          VALUES (?, ?, ?, ?, NULL, ?, ?, 50, ?, 'unverified', ?, NULL, ?, ?, ?, ?, ?)`,
        [leadId, jobId, e.name, e.company, signalText(e), e.pageUrl, day(e.at), now, e.dedupKey, FP_REVIEW_REASON, FP_SOURCE_KIND, e.companyDomain,
          'Dated by your own signed first-party event record; dazl did not check this date against a public page'])
      }
      const label = `${e.identity}; consent basis ${cfg.basis} (${cfg.policy}); receipt ${digest}${e.label ? `; ${e.label}` : ''}`.slice(0, 200)
      yield* t.run('INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [randomBytes(12).toString('hex'), leadId, tenantId, FP_CONNECTOR, FP_EVENT_KIND, e.eventKey, label, IDENTITY_CONFIDENCE[e.identity], e.pageUrl, day(e.at), now])
    }
    const counts: Record<string, number> = {}
    for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1
    if (jobId) {
      const n = (yield* t.get<{ n: number }>('SELECT COUNT(*) AS n FROM leads WHERE scan_job_id = ?', [jobId]))?.n ?? 0
      yield* t.run("UPDATE scan_jobs SET status = 'done', finished_at = ?, candidates = ?, verified = 0, needs_review = ?, dropped = 0 WHERE id = ?", [now, Number(n), Number(n), jobId])
    }
    yield* t.run(AUDIT_SQL, auditRow(tenantId, `batch:${Object.entries(counts).sort().map(([o, n]) => `${o}=${n}`).join(';')};receipt=${digest}`, 'ok', (counts.created ?? 0) + (counts.attached ?? 0), jobId))
    return { status: 'ok' as const, results, counts }
  })
}

// Tick: retention for every tenant with a recorded config, collecting or not (opting out does not stop the clock).
// The config is read inside the per-tenant transaction behind the shared config lock, so a concurrent re-record is
// never raced with a stale (shorter) period. When the encrypted config cannot be read at all, the plaintext
// first_party_config_meta row - written in the same transaction as every record - still bounds retention by the last
// recorded period; only a tenant with NO readable period anywhere is skipped (nothing is inferred).
export async function purgeFirstPartyRetention(db: Db, o: { now?: number; fence?: (t: Tx) => TxBody<void>; master?: Buffer } = {}): Promise<number> {
  const now = o.now ?? Math.floor(Date.now() / 1000)
  let purged = 0
  for (const r of await db.all<{ tenant_id: string }>('SELECT tenant_id FROM tenant_connectors WHERE connector = ? ORDER BY tenant_id', [FP_CONNECTOR])) {
    purged += await db.tx(function* (t) {
      if (o.fence) yield* o.fence(t)
      yield* lockConfig(t, r.tenant_id, false)
      const c = yield* readConfigTx(t, r.tenant_id, o.master)
      let days = c?.config.retention_days
      if (days === undefined) days = (yield* t.get<{ retention_days: number }>('SELECT retention_days FROM first_party_config_meta WHERE tenant_id = ?', [r.tenant_id]))?.retention_days
      if (days === undefined) return 0
      return yield* purgeTx(t, r.tenant_id, days, now)
    })
  }
  return purged
}

// The tenant's erase: every first-party lead and event, and the config (secret included). Collection stays off until recorded again.
export async function eraseFirstParty(db: Db, tenantId: string): Promise<number> {
  return db.tx(function* (t) {
    yield* lockConfig(t, tenantId, true)
    const n = yield* eraseLeads(t, tenantId, '', [])
    yield* t.run('DELETE FROM first_party_withdrawals WHERE tenant_id = ?', [tenantId])
    yield* t.run('DELETE FROM first_party_config_meta WHERE tenant_id = ?', [tenantId])
    yield* t.run('DELETE FROM lead_enrichments WHERE tenant_id = ? AND connector = ?', [tenantId, FP_CONNECTOR])
    yield* t.run('DELETE FROM tenant_connectors WHERE tenant_id = ? AND connector = ?', [tenantId, FP_CONNECTOR])
    yield* t.run(AUDIT_SQL, auditRow(tenantId, 'erase:all', 'erased', n))
    return n
  })
}
