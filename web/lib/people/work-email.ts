// #1036 Find work email: ONE user-clicked lookup of a checked work email for ONE buyer named on a lead.
//
// Order (free first, then the tenant's OWN keys; dazl pays for nothing):
//   1. published - the person's own address printed on the company's confirmed site (email-pattern.ts published tier).
//   2. Apollo people/match (lib/enrich/apollo.ts apolloPersonMatch) on the tenant's Apollo key.
//   3. People Data Labs person enrich (lib/enrich/pdl.ts pdlPersonEnrich) when Apollo found no usable address and PDL is
//      allowed: the only saved key, or saved with the paid-fallback opt-in (#382, Settings > Enrichment).
// What is shown as CHECKED: only 'verified' (Apollo's own email_status 'verified', with the provider and date) and
// 'published' (with the page). PDL does not verify mailboxes and Apollo's non-verified statuses are not checks, so
// those are 'unverified' and say so. Apollo's own guesses (guessed / extrapolated) are never kept. The table's CHECKs
// make 'verified' impossible without Apollo and a check time, and 'published' impossible without its page.
//
// Gates (all fail closed, each recorded as the lookup's status with a reason):
//   - the lead belongs to the tenant, is not rejected, is a company row, and sits on a SETTLED website (identityOf);
//   - the person is one of the lead's stored buyer-role targets (work-email-eligible.ts), re-derived here from stored rows;
//   - the provider's person must be the same name, not in a past role, at the same company domain, and the address must
//     be on the lead's website domain and not a shared inbox;
//   - and the SAME person, not a namesake at the same company: the provider's LinkedIn profile equals the stored one when
//     both are known (a different profile is refused); otherwise the provider must name the company (its domain) AND list
//     the same role as the stored title (sameRole), so the Director's address is never shown for the Owner of that name;
//   - US recipients only (docs/DECISIONS.md 2026-10-26): the provider's own person country must be the United States, and
//     a play whose area names another country makes no paid call. Unknown country = not US: the address is not kept.
// Spend: every paid call reserves 1 credit in the workspace credit pool first (lib/enrich/credit-pool.ts, the Settings >
// Enrichment counter and limits); a refusal makes no call. A call whose charge is unknown keeps its reservation.
// Replays: a finished lookup is returned as stored and never paid again; a lookup in flight is claimed durably
// ('pending' row) BEFORE any paid call, so a double click, a second tab or a retry while it runs pays once.
// Nothing here creates a contact, a draft or a send: drafting stays on published addresses only (#899 boundary).
import type Database from 'better-sqlite3'
import { nonCompanyHold } from '../scan/find-contact-eligible.ts'
import { audit, enrichFallbackEnabled, enrichmentsForLeads, getEnabledCredential, type Enrichment } from '../connectors/store.ts'
import { apolloPersonMatch, EnrichError, type ApolloMatch } from '../enrich/apollo.ts'
import { pdlPersonEnrich, type PdlMatch } from '../enrich/pdl.ts'
import { refundCredits, reserveCredits, settleCredits, CreditRefused, type CreditHold, type CreditProvider } from '../enrich/credit-pool.ts'
import { SpendRefused } from '../llm/spend-guard.ts'
import { OWNER_POOL_LIMIT_REASON } from '../llm/spend-pool.ts'
import { ROLE, sameSite } from '../connectors/sitecrawl.ts'
import { guessFromLearnedFormat, guessFor, guessesForLeads, type GuessView } from './email-formats.ts'
import { publishedDisplayCountry, publishedDisplayRows } from './published-display.ts'
import { splitName, emailGuessEnabled, publishedCandidateFor, publishedCandidateRowsForLeads, publishedNameKey, selectPublishedCandidate, type PublishedCandidateRow, verifyCandidates, reserveVerifySlot, verifierFromEnv, verifyDailyCap, verifyMonthlyCap, VerifySlotRefused } from './email-pattern.ts'
import { roleContradicted } from './rank.ts'
import { identityOf } from '../scan/opportunity.ts'
import { countriesIn } from '../scan/countries.ts'
import { PUBLISHED_EMAIL_RE } from '../outreach/published-email.ts'
import { isWorkEmailFixtureLead, linkedinHandle, nameKey, queryName, sameRole, siteSettled, targetKey, TARGET_KEY_MAX, workEmailLeadEligible, workEmailTargets } from './work-email-eligible.ts'
import { fixtureAvailable } from '../outreach/test-fixture.ts'
import { stagingFakePdl } from '../enrich/pdl.ts'
import { runWithTenantSpend } from '../scan/spend-cap.ts'
import { currentnessHeld } from '../outreach/currentness.ts'
import { hasCompanyFirstBudget } from '../company-first/product-discovery.ts'
import { qaClaudeOnlyJob } from '../scan/qa-provider-policy.ts'

// #1036: the test-only work-email fixture lead runs ONLY with BOTH staging fakes on (lib/enrich/pdl.ts stagingFakePdl requires
// DAZL_ENV=staging; the fake ZeroBounce needs the same plus its own flag), so neither a real People Data Labs key nor the
// operator's real ZeroBounce allowance is ever spent on a synthetic person.
export const workEmailFixtureFakesOn = (env: Record<string, string | undefined> = process.env): boolean =>
  stagingFakePdl(env) && env.DAZL_STAGING_FAKE_ZEROBOUNCE === '1'

export const WORK_EMAIL_STATUSES = ['pending', 'verified', 'published', 'unverified', 'not_found', 'not_us', 'rejected', 'error', 'uncertain'] as const
export type WorkEmailStatus = typeof WORK_EMAIL_STATUSES[number]
const FINAL_STATUSES: readonly string[] = ['verified', 'published', 'unverified', 'not_found', 'not_us', 'rejected']
const isFinal = (s: string) => FINAL_STATUSES.includes(s)
// A 'pending' claim older than this belongs to a lookup that died (both provider calls time out at 15 s): it reads as
// 'uncertain' and a new click may run again (it may have been billed: the user is told so before trying again).
export const PENDING_STALE_S = 120
export const WORK_EMAIL_CONNECTOR: Record<CreditProvider, string> = { apollo: 'workemail:apollo', pdl: 'workemail:pdl' }

export function migrateWorkEmail(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_email_lookups (
      tenant_id  TEXT NOT NULL,
      lead_id    TEXT NOT NULL,
      target     TEXT NOT NULL CHECK (length(target) <= 200),
      status     TEXT NOT NULL CHECK (status IN (${WORK_EMAIL_STATUSES.map(s => `'${s}'`).join(',')})),
      provider   TEXT CHECK (provider IS NULL OR provider IN ('site','apollo','pdl')),
      address    TEXT CHECK (address IS NULL OR length(address) <= 254),
      detail     TEXT CHECK (detail IS NULL OR length(detail) <= 300),
      source_url TEXT CHECK (source_url IS NULL OR length(source_url) <= 500),
      checked_at INTEGER,
      updated_at INTEGER NOT NULL,
      CHECK ((address IS NOT NULL) = (status IN ('verified','published','unverified'))),
      CHECK (status <> 'verified' OR (COALESCE(provider, '') = 'apollo' AND checked_at IS NOT NULL)),
      CHECK (status <> 'published' OR (COALESCE(provider, '') = 'site' AND source_url IS NOT NULL)),
      CHECK (status <> 'unverified' OR COALESCE(provider, '') IN ('apollo','pdl')),
      PRIMARY KEY (tenant_id, lead_id, target)
    );`)
  // #1036: the free-tier mailbox check of an address a provider found but did not verify (Postgres: 0064_work_email_mailbox_check.sql).
  // The status stays what the provider said ('unverified'); this records whether the mailbox itself was then checked, by whom, when.
  const has = (c: string) => (db.prepare('PRAGMA table_info(work_email_lookups)').all() as { name: string }[]).some(r => r.name === c)
  if (!has('mailbox_check')) db.exec(`ALTER TABLE work_email_lookups ADD COLUMN mailbox_check TEXT CHECK (mailbox_check IS NULL OR mailbox_check IN (${MAILBOX_CHECKS.map(s => `'${s}'`).join(',')}))`)
  if (!has('mailbox_verifier')) db.exec('ALTER TABLE work_email_lookups ADD COLUMN mailbox_verifier TEXT CHECK (mailbox_verifier IS NULL OR length(mailbox_verifier) <= 40)')
  if (!has('mailbox_checked_at')) db.exec('ALTER TABLE work_email_lookups ADD COLUMN mailbox_checked_at INTEGER')
  // the tenant's daily mailbox-check count (email-pattern.ts reserveVerifySlot) reads this index
  db.exec('CREATE INDEX IF NOT EXISTS work_email_lookups_mailbox_checked ON work_email_lookups (tenant_id, mailbox_checked_at)')
}
// pending: a slot was reserved and the call did not finish (never shown as checked). valid: the verifier's explicit "valid".
export const MAILBOX_CHECKS = ['pending', 'valid', 'catch_all', 'undeliverable', 'uncertain', 'refused'] as const

// The ONE shape every route returns (GET workEmailsFor, POST findWorkEmail): an address the mailbox check found does not exist
// ('undeliverable') or flagged do-not-mail ('refused') is never sent to the client at all, not merely hidden by the panel. A
// mailbox check still 'pending' past PENDING_STALE_S (its process died) reads as 'uncertain'. Kept rows are never changed.
export function shownRow(r: WorkEmailRow, nowS: number): WorkEmailRow {
  const hidden = r.mailbox_check === 'undeliverable' || r.mailbox_check === 'refused'
  const stale = r.mailbox_check === 'pending' && (r.mailbox_checked_at ?? 0) < nowS - PENDING_STALE_S
  return hidden || stale ? { ...r, ...(hidden ? { address: null } : {}), ...(stale ? { mailbox_check: 'uncertain' } : {}) } : r
}
export interface WorkEmailRow { target: string; status: WorkEmailStatus; provider: string | null; address: string | null; detail: string | null; source_url: string | null; checked_at: number | null; updated_at: number; mailbox_check?: string | null; mailbox_verifier?: string | null; mailbox_checked_at?: number | null }
const ROW_COLS = 'target, status, provider, address, detail, source_url, checked_at, updated_at, mailbox_check, mailbox_verifier, mailbox_checked_at'

// Stored lookups for one lead of this tenant, as shown on the lead. A 'pending' row past PENDING_STALE_S reads as 'uncertain'.
export function workEmailsFor(db: Database.Database, tenantId: string, leadId: string, nowS: number = Math.floor(Date.now() / 1000)): WorkEmailRow[] {
  migrateWorkEmail(db)
  const rows = db.prepare(`SELECT ${ROW_COLS} FROM work_email_lookups WHERE tenant_id = ? AND lead_id = ? ORDER BY target`).all(tenantId, leadId) as WorkEmailRow[]
  return rows.map(r => shownRow(r, nowS)).map(r => r.status === 'pending' && r.updated_at < nowS - PENDING_STALE_S ? { ...r, status: 'uncertain' as const, detail: 'the last lookup did not finish; it may have used a credit' } : r)
}

// #1182: the stored lookups of every lead a Leads page shows, in ONE tenant-scoped read (WHERE tenant_id = ? AND lead_id IN (...), the table's
// primary key is (tenant_id, lead_id, target)), grouped by lead. Same mapping as workEmailsFor (a stale 'pending' reads 'uncertain'; an
// address the mailbox check found undeliverable or do-not-mail is never included).
export function workEmailsForLeads(db: Database.Database, tenantId: string, leadIds: string[], nowS: number = Math.floor(Date.now() / 1000)): Record<string, WorkEmailRow[]> {
  migrateWorkEmail(db)
  const out: Record<string, WorkEmailRow[]> = {}
  const ids = [...new Set(leadIds.filter(id => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id)))]
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200)
    const rows = db.prepare(`SELECT lead_id, ${ROW_COLS} FROM work_email_lookups WHERE tenant_id = ? AND lead_id IN (${part.map(() => '?').join(',')}) ORDER BY lead_id, target`).all(tenantId, ...part) as (WorkEmailRow & { lead_id: string })[]
    for (const { lead_id, ...r } of rows) {
      const shown = shownRow(r as WorkEmailRow, nowS)
      const row = shown.status === 'pending' && shown.updated_at < nowS - PENDING_STALE_S ? { ...shown, status: 'uncertain' as const, detail: 'the last lookup did not finish; it may have used a credit' } : shown
      ;(out[lead_id] ??= []).push(row)
    }
  }
  return out
}

// What the Leads page needs for every work-email block on it, read once with the list (#1182): the providers answer (the same for every
// lead, except the test-only fixture lead, whose answer is adjusted exactly as its own GET does) and the stored lookups by lead.
// guesses (#1036): the shown guessed addresses by lead (flag off or none: {}), so a reload shows a stored guess with no per-lead request.
export interface WorkEmailPageRead { providers: WorkEmailProviders; providers_by_lead: Record<string, WorkEmailProviders>; lookups: Record<string, WorkEmailRow[]>; guesses: Record<string, GuessView[]> }
export function workEmailPageRead(db: Database.Database, tenantId: string, leads: { id: string; company?: string | null; source_kind?: string | null }[], env: Record<string, string | undefined> = process.env): WorkEmailPageRead {
  const providers = workEmailProviders(db, tenantId, env)
  const providers_by_lead: Record<string, WorkEmailProviders> = {}
  const ids = [...new Set(leads.map(l => l.id).filter(id => /^[a-f0-9]{24}$/.test(id)))]
  const strictLookups = strictPublishedWorkEmailsForLeads(db, tenantId, ids)
  for (const l of leads) {
    if (Object.hasOwn(strictLookups, l.id)) providers_by_lead[l.id] = PUBLISHED_ONLY_WORK_EMAIL_PROVIDERS
    else if (isWorkEmailFixtureLead(l)) providers_by_lead[l.id] = { ...providers, apollo: false, pdl: providers.pdl || providers.pdlNeedsOptIn, pdlNeedsOptIn: false }
  }
  const ordinary = ids.filter(id => !Object.hasOwn(strictLookups, id))
  const lookups = ordinary.length ? workEmailsForLeads(db, tenantId, ordinary) : {}
  return { providers, providers_by_lead, lookups: { ...lookups, ...strictLookups }, guesses: guessesForLeads(db, tenantId, ordinary, env) }
}

// The same durable owner/job machine proof as ordinary Leads/Ready. Older
// native strict jobs intentionally retain their existing review behavior.
function markedWorkEmailHeld(db:Database.Database,tenantId:string,lead:LeadRow,now:number):boolean{
  if(!hasCompanyFirstBudget(lead.run_budget))return false
  try { return currentnessHeld(db,tenantId,lead.id,new Date(now*1000)) } catch { return true }
}

// Strict GET and page preload reconstruct the same response as POST, with no cached lookup rows.
// Fetch owned lead provenance, people/site data, and published candidates in bounded batches.
export function strictPublishedWorkEmailsForLeads(db: Database.Database, tenantId: string, leadIds: string[], now = Math.floor(Date.now() / 1000)): Record<string, WorkEmailRow[]> {
  const ids = [...new Set(leadIds.filter(id => /^[a-f0-9]{24}$/.test(id)))]
  const out: Record<string, WorkEmailRow[]> = {}
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200)
    const owned = db.prepare(`SELECT ${LEAD_COLS} FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? AND l.id IN (${part.map(() => '?').join(',')})`).all(tenantId, ...part) as LeadRow[]
    const strict = owned.filter(l => qaClaudeOnlyJob(l.run_budget) || hasCompanyFirstBudget(l.run_budget))
    for(const l of strict) out[l.id] = [] // ensure held strict rows never fall back to legacy lookup/guess data
    const readable = strict.filter(l => !markedWorkEmailHeld(db,tenantId,l,now))
    const strictIds = readable.map(l => l.id)
    const enriched = enrichmentsForLeads(db, tenantId, strictIds)
    const projected = readable.map(l => ({ l, ctx: workEmailTargetContext(l, enriched[l.id] ?? [], now) }))
    const idsFor = (country: 'CA' | 'GB' | null) => projected.filter(r => r.ctx && publishedDisplayCountry(r.ctx.where) === country).map(r => r.l.id)
    const candidates = { ...publishedCandidateRowsForLeads(db, tenantId, idsFor(null)),
      ...publishedDisplayRows(db, tenantId, 'CA', idsFor('CA')), ...publishedDisplayRows(db, tenantId, 'GB', idsFor('GB')) }
    for (const { l, ctx } of projected) {
      if (!eligibleWorkEmailLead(l, enriched[l.id] ?? []) || isWorkEmailFixtureLead(l)) continue
      if (!ctx) continue
      out[l.id] = ctx.people.map(person => strictPublishedRow(targetKey(person), person.name, ctx, candidates[l.id] ?? [], now)).filter(r => r.status === 'published')
    }
  }
  return out
}

// Which of the tenant's own keys a lookup would use (presence only: no key is decrypted here).
// mailboxCheck (#1036): the free-tier mailbox check can run at all here (flag, key and both caps set), so the UI offers it.
export interface WorkEmailProviders { apollo: boolean; pdl: boolean; pdlNeedsOptIn: boolean; mailboxCheck: boolean; publishedOnly?: boolean }
export const PUBLISHED_ONLY_WORK_EMAIL_PROVIDERS: WorkEmailProviders = { apollo: false, pdl: false, pdlNeedsOptIn: false, mailboxCheck: false, publishedOnly: true }
export function workEmailProviders(db: Database.Database, tenantId: string, env: Record<string, string | undefined> = process.env): WorkEmailProviders {
  const saved = new Set((db.prepare("SELECT connector FROM tenant_connectors WHERE tenant_id = ? AND enabled = 1 AND ciphertext <> '' AND connector IN ('enrich:apollo','enrich:pdl')").all(tenantId) as { connector: string }[]).map(r => r.connector))
  const apollo = saved.has('enrich:apollo'), pdlSaved = saved.has('enrich:pdl')
  const optIn = apollo && pdlSaved ? enrichFallbackEnabled(db, tenantId) : true
  const verifier = verifierFromEnv(env)
  let mailboxCheck = !!verifier && emailGuessEnabled(env) && verifyDailyCap(env) > 0 && verifyMonthlyCap(env) > 0
  // A spent monthly allowance (the operator ledger) also means no check can run this month: no button that does nothing.
  if (mailboxCheck && verifier) {
    try {
      const used = (db.prepare('SELECT n FROM email_verify_usage WHERE verifier = ? AND month = ?').get(verifier.name.slice(0, 40), new Date().toISOString().slice(0, 7)) as { n: number } | undefined)?.n ?? 0
      if (used >= verifyMonthlyCap(env)) mailboxCheck = false
    } catch (e) { if (!/no such table/i.test(String((e as Error)?.message))) throw e }
  }
  return { apollo, pdl: pdlSaved && optIn, pdlNeedsOptIn: pdlSaved && !optIn, mailboxCheck }
}

// guess (#1036): with EMAIL_GUESS_ENABLED, when nothing was found for this person ('not_found', or no key to look further), an address
// built from the tenant's learned format at this company's domain, labelled guessed, unverified/verified (lib/people/email-formats.ts).
// Never a lookup row, never copyable unless a mailbox check said valid, never a draft recipient.
export type FindWorkEmailResult =
  | { status: 'lead_not_found' | 'not_eligible' | 'site_unsettled' | 'no_key' | 'busy'; detail: string; guess?: GuessView | null }
  | { status: WorkEmailStatus; row: WorkEmailRow; replayed: boolean; guess?: GuessView | null }

interface LeadRow { id: string; scan_job_id: string; company: string; contact: string | null; source_url: string | null; quarantined_at: number | null; source_kind: string | null; human_confirmed_from: string | null; review_reason: string | null; icp: string | null; run_budget: string | null }

const LEAD_COLS = 'l.id, l.scan_job_id, l.company, l.contact, l.source_url, l.quarantined_at, l.source_kind, l.human_confirmed_from, l.review_reason, j.icp, j.run_budget'
// #1177: the hold rule reads the lead's own stored website rows (a customer mention with its own settled website is a company row).
const eligibleWorkEmailLead = (lead: LeadRow, rows: Enrichment[]) => { const l = { ...lead, enrichments: rows }; return !lead.quarantined_at && !nonCompanyHold(lead.review_reason, l) && workEmailLeadEligible(l) }

function workEmailTargetContext(lead: LeadRow, rows: Enrichment[], now: number) {
  const identity = identityOf({ id: lead.id, contact: lead.contact }, rows)
  if (!siteSettled(identity)) return null
  let icp: { who?: unknown; where?: unknown } = {}
  try { const p = lead.icp ? JSON.parse(lead.icp) : null; if (p && typeof p === 'object' && !Array.isArray(p)) icp = p } catch { icp = {} }
  const strs = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  const icpText = strs(icp.who).join('; ')
  return { site: identity.site, icpText, where: strs(icp.where), people: workEmailTargets(rows, icpText, now * 1000, identity) }
}

function strictPublishedRow(target: string, name: string, ctx: NonNullable<ReturnType<typeof workEmailTargetContext>>, candidates: PublishedCandidateRow[], now: number): WorkEmailRow {
  const key = publishedNameKey(name)
  // Candidate matching uses only normalized first/last, not title. Never give that address to two eligible title keys.
  const matches = key ? ctx.people.filter(p => publishedNameKey(p.name) === key).length : 0
  const candidate = matches === 1 ? selectPublishedCandidate(candidates, name) : null
  const firstParty = (url: string) => {
    try {
      const u = new URL(url)
      return url.length <= 500 && u.protocol === 'https:' && !u.username && !u.password && !u.port && sameSite(u.hostname, ctx.site)
    } catch { return false }
  }
  const pub = candidate && candidate.address.length <= 254 && PUBLISHED_EMAIL_RE.test(candidate.address) && sameSite(domainOf(candidate.address), ctx.site) && firstParty(candidate.url) ? candidate : null
  return { target, status: pub ? 'published' : 'not_found', provider: pub ? 'site' : null, address: (pub && (publishedDisplayCountry(ctx.where) ? pub.address : pub.address.toLowerCase())) || null,
    source_url: pub?.url ?? null, checked_at: null, updated_at: now,
    detail: pub ? 'printed on the company website' : matches > 1
      ? 'Multiple eligible people share this name. The company publication does not distinguish them; no broker or mailbox check ran.'
      : 'No address for this buyer was printed on the company website. This scan permits only published addresses; no broker or mailbox check ran.' }
}

const isUS = (c: string | null) => !!c && /^(?:united states(?: of america)?|usa?|u\.s\.a?\.?)$/i.test(c.trim())
const domainOf = (address: string) => (address.split('@')[1] ?? '').toLowerCase()
const sameCompany = (a: string, site: string) => sameSite(a, site) || sameSite(site, a)

type Verdict =
  | { kind: 'verified' | 'unverified'; address: string; note: string }
  | { kind: 'none' | 'guess' | 'rejected' | 'not_us'; note: string }

// Judge one provider answer against the person and the lead's website. Pure; every branch names its reason.
// `want` is the stored target: its query name plus its stored title and LinkedIn profile (null when not known).
export interface WantPerson { first: string; last: string; title: string | null; linkedin: string | null }
export function judgeMatch(provider: CreditProvider, m: (ApolloMatch | PdlMatch) | null, want: WantPerson, site: string, icpText = ''): Verdict {
  const P = provider === 'apollo' ? 'Apollo' : 'People Data Labs'
  if (!m) return { kind: 'none', note: `${P} had no match` }
  const a = m as Partial<ApolloMatch>
  const words = (m.name ?? '').split(/\s+/).filter(Boolean)
  const first = nameKey(a.first ?? words[0] ?? ''), last = nameKey(a.last ?? words[words.length - 1] ?? '')
  if (!first || !last || first !== nameKey(want.first) || last !== nameKey(want.last)) return { kind: 'rejected', note: `${P} returned a different person` }
  if (m.title && roleContradicted(m.title, icpText)) return { kind: 'rejected', note: `${P} lists a past or assistant role (${m.title.slice(0, 60)})` }
  const org = typeof m.orgDomain === 'string' ? m.orgDomain.trim().toLowerCase() : ''
  if (org && !sameCompany(org, site)) return { kind: 'rejected', note: `${P} has them at another company (${org.slice(0, 60)})` }
  // Same person, not a namesake at the same company (two people called Alex Smith).
  const wantIn = linkedinHandle(want.linkedin), gotIn = linkedinHandle(m.linkedin)
  if (wantIn && gotIn && wantIn !== gotIn) return { kind: 'rejected', note: `${P} returned a different LinkedIn profile than the one on this lead` }
  if (!(wantIn && gotIn)) {
    if (!org) return { kind: 'rejected', note: `${P} does not name their company, so it could not be confirmed this is the same person` }
    const t = typeof m.title === 'string' ? m.title : ''
    if (!t) return { kind: 'rejected', note: `${P} lists no role, so it could not be confirmed this is the same person` }
    if (!sameRole(want.title, t)) return { kind: 'rejected', note: `${P} lists a different role (${t.slice(0, 60)}), so it may be someone else with this name` }
  }
  const email = (m.email ?? '').trim().toLowerCase()
  if (!email) return { kind: 'none', note: `${P} has no work email for them` }
  if (!PUBLISHED_EMAIL_RE.test(email) || email.length > 254) return { kind: 'none', note: `${P} returned an unreadable address` }
  if (!sameSite(domainOf(email), site)) return { kind: 'rejected', note: `${P}'s address is not on ${site}` }
  if (ROLE.test(email.split('@')[0].replace(/[._-]/g, ''))) return { kind: 'rejected', note: `${P} returned a shared inbox, not the person's address` }
  if (!isUS(m.country)) return { kind: 'not_us', note: `${P} does not place them in the US${m.country ? ` (${m.country.slice(0, 40)})` : ' (no country)'}` }
  if (provider === 'apollo') {
    const st = (a.emailStatus ?? '').toLowerCase()
    if (st === 'verified') return { kind: 'verified', address: email, note: 'Apollo verified' }
    if (st === 'guessed' || st === 'extrapolated') return { kind: 'guess', note: 'Apollo only had a guessed address (not kept)' }
    if (st === 'bounced') return { kind: 'rejected', note: 'Apollo reports this address bounced' }
    if (st === 'unavailable') return { kind: 'none', note: 'Apollo has no work email for them' }
    return { kind: 'unverified', address: email, note: `Apollo has it, not verified${st ? ` (${st.slice(0, 30)})` : ''}` }
  }
  return { kind: 'unverified', address: email, note: 'People Data Labs has it; PDL does not check mailboxes' }
}

const failText = (e: unknown, P: string) => {
  if (e instanceof EnrichError) return e.code === 'auth' ? `${P} rejected your key` : e.code === 'rate_limited' ? `${P} rate limit reached` : `${P} error`
  const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : null
  return name === 'AbortError' || name === 'TimeoutError' ? `${P} timed out (may have used a credit)` : `${P} answer could not be read (may have used a credit)`
}

type FindDeps = { fetchImpl?: typeof fetch; master?: Buffer; env?: Record<string, string | undefined>; now?: number }
// What the lookup worked out about the person (filled by lookupWorkEmail), so the guess is built from exactly the same derivation.
interface Derived { publishedOnly?: boolean; foreign?: boolean; person?: { name: string; title: string | null }; site?: string; others?: ReturnType<typeof splitName>[] }
// #1167: its priced steps are counted on the tenant's account windows (lib/scan/spend-cap.ts runWithTenantSpend)
export async function findWorkEmail(db: Database.Database, tenantId: string, leadId: string, target: unknown, deps: FindDeps = {}): Promise<FindWorkEmailResult> {
  return runWithTenantSpend(db, tenantId, () => findWorkEmailCounted(db, tenantId, leadId, target, deps))
}
async function findWorkEmailCounted(db: Database.Database, tenantId: string, leadId: string, target: unknown, deps: FindDeps = {}): Promise<FindWorkEmailResult> {
  const derived: Derived = {}
  const r = await lookupWorkEmail(db, tenantId, leadId, target, deps, derived)
  // Only where nothing was found: a found address (published, verified, found-not-checked) is never replaced or joined by a guess.
  // US only (docs/DECISIONS.md 2026-10-26): a play that names another country gets published addresses only, so no guess either. The paid
  // path refuses such a play AFTER its no-key return, so a keyless workspace must be stopped here, not by that check.
  if (derived.publishedOnly || (r.status !== 'not_found' && r.status !== 'no_key') || !derived.person || !derived.site || derived.foreign !== false) return r
  let guess: GuessView | null = null
  try {
    const env = deps.env ?? process.env
    guess = guessFromLearnedFormat(db, tenantId, leadId, derived.person, derived.site, (derived.others ?? []).filter((n): n is NonNullable<typeof n> => !!n), env)
    if (guess) {
      // The click can create a guess after the scan's verifier pass. Check only this target's address,
      // using the same reservation and caps; a replay never rechecks a finished candidate.
      await verifyCandidates(db, tenantId, leadId, verifierFromEnv(env, deps.fetchImpl), { env, address: guess.address, ...(deps.now === undefined ? {} : { now: deps.now * 1000 }) })
      guess = guessFor(db, tenantId, leadId, derived.person.name, env)
    }
  } catch (e) { console.error('[work-email] learned-format guess not made:', e instanceof Error ? e.message.slice(0, 120) : 'error') }
  return guess ? { ...r, guess } : r
}

async function lookupWorkEmail(
  db: Database.Database, tenantId: string, leadId: string, target: unknown,
  deps: FindDeps, derived: Derived,
): Promise<FindWorkEmailResult> {
  const now = deps.now ?? Math.floor(Date.now() / 1000)
  if (typeof target !== 'string' || !target || target.length > TARGET_KEY_MAX) return { status: 'not_eligible', detail: 'no such person on this lead' }
  const lead = db.prepare(`SELECT ${LEAD_COLS}
    FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?`).get(leadId, tenantId) as LeadRow | undefined
  if (!lead) return { status: 'lead_not_found', detail: 'lead not found' }
  if (markedWorkEmailHeld(db,tenantId,lead,now)) return { status: 'not_eligible', detail: 'This lead remains held; no contact lookup ran.' }
  // #1036: a lead still in review may be looked up (the review is about the signal), except one held because its "company" is a
  // person's handle or the other side of a post (the cited page is about someone else, so the row is not established as this
  // company's lead; the same rule as the Leads page and Find contact). It fails closed even when a website was recorded, except
  // (#1177) a customer mention whose OWN website is settled (find-contact-eligible.ts counterpartyOwnSite): the company is then
  // established by its own site, not by the cited page.
  const rows = enrichmentsForLeads(db, tenantId, [lead.id])[lead.id] ?? []
  const withRows = { ...lead, enrichments: rows }
  if (nonCompanyHold(lead.review_reason, withRows)) return { status: 'not_eligible', detail: 'this row is not a company' }
  if (lead.quarantined_at) return { status: 'not_eligible', detail: 'this lead was rejected' }
  if (!workEmailLeadEligible(withRows)) return { status: 'not_eligible', detail: 'this row is not a company' }
  // #1036: the test-only work-email fixture lead is looked up ONLY on the test tenant with the staging fake PDL on (never a real
  // provider: Apollo is skipped for it below), so no real key is ever charged for a synthetic person.
  const fixture = isWorkEmailFixtureLead(lead)
  if (fixture && !(fixtureAvailable(db, tenantId) && workEmailFixtureFakesOn(deps.env ?? process.env))) return { status: 'not_eligible', detail: 'this test-only fixture lead is looked up only on staging with the fake People Data Labs and the fake ZeroBounce' }
  derived.publishedOnly = qaClaudeOnlyJob(lead.run_budget) || hasCompanyFirstBudget(lead.run_budget)
  if (derived.publishedOnly && fixture) return { status: 'not_eligible', detail: 'a strict-origin result must come from the company website' }
  const ctx = workEmailTargetContext(lead, rows, now)
  if (!ctx) return { status: 'site_unsettled', detail: "the company's website is not settled yet, so an address on it cannot be checked" }
  const person = ctx.people.find(p => targetKey(p) === target)
  if (!person) return { status: 'not_eligible', detail: 'no such buyer-role person on this lead' }
  if (derived.publishedOnly) {
    const country = publishedDisplayCountry(ctx.where)
    const candidates = country ? publishedDisplayRows(db, tenantId, country, [lead.id]) : publishedCandidateRowsForLeads(db, tenantId, [lead.id])
    const row = strictPublishedRow(target, person.name, ctx, candidates[lead.id] ?? [], now)
    return { status: row.status, row, replayed: false }
  }
  migrateWorkEmail(db)
  const foreign = [...new Set(ctx.where.flatMap(w => countriesIn(w)))].filter(c => c !== 'US')
  derived.foreign = foreign.length > 0
  const icpText = ctx.icpText
  const site = { site: ctx.site }
  const published = () => {
    const pub = publishedCandidateFor(db, tenantId, lead.id, person.name)
    return pub && sameSite(domainOf(pub.address), site.site) ? pub : null
  }
  const want: WantPerson = { ...queryName(person.name)!, title: person.title, linkedin: person.linkedin }
  derived.person = { name: person.name, title: person.title }; derived.site = site.site
  derived.others = ctx.people.map(p => splitName(p.name))

  const read = () => db.prepare(`SELECT ${ROW_COLS} FROM work_email_lookups WHERE tenant_id = ? AND lead_id = ? AND target = ?`).get(tenantId, lead.id, target) as WorkEmailRow | undefined
  const prior = read()
  if (prior && isFinal(prior.status)) {
    // A found-but-unverified address whose mailbox check never ran (the caps were used up, or the key or flag came later) gets it
    // now: no provider credit is spent again, only one free-tier check under the same caps.
    if (prior.status === 'unverified' && prior.address && (prior.mailbox_check ?? null) === null) { await checkMailbox(db, tenantId, lead.id, target, prior.address, deps); return { status: prior.status, row: shownRow(read() ?? prior, now), replayed: true } }
    return { status: prior.status, row: shownRow(prior, now), replayed: true }
  }
  if (prior?.status === 'pending' && prior.updated_at >= now - PENDING_STALE_S) return { status: 'busy', detail: 'a lookup for this person is already running' }

  const save = (status: WorkEmailStatus, f: { provider?: string | null; address?: string | null; detail?: string | null; source_url?: string | null; checked_at?: number | null }, claimedAt?: number): boolean => {
    const args = [status, f.provider ?? null, f.address ?? null, (f.detail ?? null)?.slice(0, 300) ?? null, f.source_url ?? null, f.checked_at ?? null, now]
    if (claimedAt === undefined) return db.prepare(`INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, provider, address, detail, source_url, checked_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, lead_id, target) DO UPDATE SET status = excluded.status, provider = excluded.provider, address = excluded.address, detail = excluded.detail, source_url = excluded.source_url, checked_at = excluded.checked_at, updated_at = excluded.updated_at
      WHERE work_email_lookups.status NOT IN ('verified','published','unverified','not_found','not_us','rejected','pending')`).run(tenantId, lead.id, target, ...args).changes === 1
    return db.prepare(`UPDATE work_email_lookups SET status = ?, provider = ?, address = ?, detail = ?, source_url = ?, checked_at = ?, updated_at = ? WHERE tenant_id = ? AND lead_id = ? AND target = ? AND status = 'pending' AND updated_at = ?`)
      .run(...args, tenantId, lead.id, target, claimedAt).changes === 1
  }
  const done = (replayed = false): FindWorkEmailResult => { const r = read()!; return { status: r.status, row: shownRow(r, now), replayed } }

  // 1. Free: the person's own address printed on the confirmed site.
  const pub = published()
  if (pub) {
    save('published', { provider: 'site', address: pub.address.toLowerCase(), source_url: pub.url.slice(0, 500), detail: 'printed on the company website' })
    return done()
  }

  // 2-3. The tenant's own keys. A key that cannot be read is a recorded failure for that provider, never a silent skip.
  // Which providers may run is decided from the SAVED keys (workEmailProviders), before any key is decrypted: with both
  // saved and the #382 paid-fallback opt-in off, PDL never runs, even when the Apollo key turns out unreadable.
  // `incomplete`: a provider that was allowed gave no answer (unreadable key, credit limit, failed call). Then the lookup
  // is not finished: it ends retryable ('error'), never as a final 'not found' / 'rejected' / 'not_us'.
  const notes: string[] = []
  let incomplete = false
  const allowed = workEmailProviders(db, tenantId)
  // The fixture never uses Apollo, so the opt-in that only gates PDL-after-Apollo does not apply to it: its saved PDL key runs.
  const pdlAllowed = fixture ? allowed.pdl || allowed.pdlNeedsOptIn : allowed.pdl
  const pdlOff = !fixture && allowed.pdlNeedsOptIn
  const loadKey = (c: string, P: string): string | null => {
    try { const k = getEnabledCredential(db, tenantId, c, deps.master); if (typeof k === 'string' && k) return k } catch { /* recorded below */ }
    notes.push(`${P} key could not be read`); incomplete = true; return null
  }
  const keys: Record<CreditProvider, string | null> = { apollo: allowed.apollo && !fixture ? loadKey('enrich:apollo', 'Apollo') : null, pdl: pdlAllowed ? loadKey('enrich:pdl', 'People Data Labs') : null }
  if (!keys.apollo && !keys.pdl) {
    if (notes.length) { save('error', { detail: notes.join('; ') }); return done() }
    return { status: 'no_key', detail: 'no Apollo or People Data Labs key saved' }
  }
  if (foreign.length) { save('not_us', { detail: `this play's area names ${foreign.join(', ')}; outside the US only published addresses are used, so no paid lookup ran` }); return done() }

  // Durable claim BEFORE any paid call: a fresh row, or a retry of a failed/uncertain/stale one. Losing the race = busy.
  const claimed = db.prepare(`INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, updated_at) VALUES (?, ?, ?, 'pending', ?)
    ON CONFLICT (tenant_id, lead_id, target) DO UPDATE SET status = 'pending', provider = NULL, address = NULL, detail = NULL, source_url = NULL, checked_at = NULL, updated_at = excluded.updated_at
    WHERE work_email_lookups.status IN ('error','uncertain') OR (work_email_lookups.status = 'pending' AND work_email_lookups.updated_at < ?)`).run(tenantId, lead.id, target, now, now - PENDING_STALE_S).changes === 1
  if (!claimed) { const r = read(); return r && isFinal(r.status) ? { status: r.status, row: shownRow(r, now), replayed: true } : { status: 'busy', detail: 'a lookup for this person is already running' } }

  const fetchImpl = deps.fetchImpl ?? fetch
  let best: Extract<Verdict, { kind: 'verified' | 'unverified' }> & { provider: CreditProvider } | null = null
  const seen = new Set<Verdict['kind']>()
  let answered = false
  try {
    for (const prov of ['apollo', 'pdl'] as CreditProvider[]) {
      const key = keys[prov]; if (!key) continue
      const P = prov === 'apollo' ? 'Apollo' : 'People Data Labs'
      const log = (status: string, results = 0) => { try { audit(db, { tenantId, connector: WORK_EMAIL_CONNECTOR[prov], jobId: null, lookup: `work email: lead ${lead.id}`, status: status.slice(0, 200), results }) } catch (e) { console.error('[work-email] audit not saved:', e instanceof Error ? e.message.slice(0, 120) : 'error') } }
      let hold: CreditHold
      try { hold = await reserveCredits(db, tenantId, prov, 1, { env: deps.env, now }) }
      catch (e) { const t = e instanceof CreditRefused && e.reason === 'credit_cap' ? `${P} credit limit reached (Settings > Enrichment)` : `${P} credit reservation could not be saved`; notes.push(t); incomplete = true; log(e instanceof CreditRefused && e.reason === 'credit_cap' ? 'credit_cap' : 'credit_unsaved'); continue }
      let v: Verdict
      try {
        if (prov === 'apollo') {
          const m = await apolloPersonMatch(key, { first: want.first, last: want.last, domain: site.site, organization: lead.company }, fetchImpl)
          await settle(db, hold, 1) // Apollo answered: counted as charged (an over-count, never an under-count)
          v = judgeMatch('apollo', m, want, site.site, icpText)
        } else {
          const r = await pdlPersonEnrich(key, { first: want.first, last: want.last, domain: site.site }, fetchImpl, { env: deps.env, hints: { title: want.title, linkedin: want.linkedin } })
          await settle(db, hold, r.billed ? 1 : 0) // 404 = PDL's unbilled no-match
          v = judgeMatch('pdl', r.match, want, site.site, icpText)
        }
      } catch (e) {
        // #1167: the account's day / month spend cap refused the lookup BEFORE it was sent: the credit goes back, and the
        // next provider would be refused by the same cap
        if (e instanceof SpendRefused) {
          await refundCredits(db, hold).catch((x) => console.error('[work-email] credit refund not saved (reservation kept):', x instanceof Error ? x.message.slice(0, 120) : 'error'))
          const cap = e.reason === OWNER_POOL_LIMIT_REASON
          notes.push(cap ? 'account spend limit reached: nothing was sent' : `spend check refused the lookup (${e.reason}): nothing was sent`); incomplete = true; log(cap ? 'spend_cap' : `spend_refused:${e.reason}`); break
        }
        notes.push(failText(e, P)); incomplete = true; log(e instanceof EnrichError ? e.code : 'error'); continue // charge unknown: the reservation stays
      }
      answered = true
      seen.add(v.kind); notes.push(v.note); log(v.kind, v.kind === 'verified' || v.kind === 'unverified' ? 1 : 0)
      if (v.kind === 'verified' || v.kind === 'unverified') { best = { ...v, provider: prov }; break } // a kept address: no further spend
    }
  } catch (e) {
    save('uncertain', { detail: `lookup stopped: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}` }, now)
    return done()
  }
  if (!best && pdlOff) notes.push('People Data Labs fallback is off (turn it on in Settings > Enrichment)')
  const detail = notes.join('; ')
  if (best) {
    save(best.kind, { provider: best.provider, address: best.address, detail, checked_at: best.kind === 'verified' ? now : null, source_url: null }, now)
    // #1036/#899: an address the provider found but did not verify gets the free-tier mailbox check, under the shared caps.
    if (best.kind === 'unverified') await checkMailbox(db, tenantId, lead.id, target, best.address, deps)
  }
  else if (!answered || incomplete) save('error', { detail }, now) // an allowed provider gave no answer: retryable
  else if (seen.has('not_us')) save('not_us', { detail }, now)
  else if (seen.has('rejected')) save('rejected', { detail }, now)
  else save('not_found', { detail }, now)
  return done()
}

// The free-tier check of one found address (lib/people/zerobounce.ts via verifierFromEnv): only with EMAIL_GUESS_ENABLED, a
// ZEROBOUNCE_API_KEY and room under both caps. Only an explicit 'deliverable' becomes 'valid'; a catch-all domain never does.
// Any failure leaves 'uncertain' (the slot stays counted). Never throws: the lookup's own result is already saved.
async function checkMailbox(db: Database.Database, tenantId: string, leadId: string, target: string, address: string, deps: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; now?: number }): Promise<void> {
  const env = deps.env ?? process.env
  const verifier = verifierFromEnv(env, deps.fetchImpl)
  const dailyCap = verifyDailyCap(env), monthCap = verifyMonthlyCap(env)
  if (!verifier || !emailGuessEnabled(env) || dailyCap === 0 || monthCap === 0) return
  const nowS = deps.now ?? Math.floor(Date.now() / 1000)
  // The same reservation as the scan's guess checks (#849 inventory): refused (a cap, or another tab took it) = no call.
  // The claim moves updated_at, so another open tab sees 'pending' (checking) rather than a finished row.
  try {
    await reserveVerifySlot(db, { tenantId, verifier: verifier.name, nowS, dailyCap, monthCap },
      () => db.prepare("UPDATE work_email_lookups SET mailbox_check = 'pending', mailbox_verifier = ?, mailbox_checked_at = ?, updated_at = ? WHERE tenant_id = ? AND lead_id = ? AND target = ? AND status = 'unverified' AND address = ? AND mailbox_check IS NULL").run(verifier.name.slice(0, 40), nowS, Math.max(Math.floor(Date.now() / 1000), nowS), tenantId, leadId, target, address).changes === 1)
  } catch (e) {
    if (!(e instanceof VerifySlotRefused)) console.error('[work-email] mailbox check not reserved:', e instanceof Error ? e.message.slice(0, 120) : 'error')
    return
  }
  let out: (typeof MAILBOX_CHECKS)[number] = 'uncertain'
  try {
    const a = await verifier.verify(address)
    out = a?.outcome === 'deliverable' ? 'valid' : a?.outcome === 'catch_all' ? 'catch_all' : a?.outcome === 'undeliverable' ? 'undeliverable' : a?.outcome === 'refused' ? 'refused' : 'uncertain'
  } catch { out = 'uncertain' }
  // updated_at moves again so another open tab's merge (mergeLookups) takes the settled row
  try { db.prepare("UPDATE work_email_lookups SET mailbox_check = ?, updated_at = ? WHERE tenant_id = ? AND lead_id = ? AND target = ? AND mailbox_check = 'pending'").run(out, Math.max(Math.floor(Date.now() / 1000), nowS) + 1, tenantId, leadId, target) }
  catch (e) { console.error('[work-email] mailbox check not recorded:', e instanceof Error ? e.message.slice(0, 120) : 'error') }
}

async function settle(db: Database.Database, h: CreditHold, charged: number): Promise<void> {
  try { await settleCredits(db, h, charged) } catch (e) { console.error('[work-email] credit settle not saved (reservation kept):', e instanceof Error ? e.message.slice(0, 120) : 'error') }
}
