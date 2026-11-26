// #1036 / #1250 Find work email: the address the company prints on its own website for ONE buyer named on a lead.
//
// The only source is the company itself: an address printed on the lead's own confirmed site and filed under this person by the crawl
// (email-pattern.ts published tier, or the published display rows for a Canada / UK scan). No learned-format guess, no Apollo or
// People Data Labs answer and no mailbox check, on any scan; nothing is stored, so every read rebuilds the same answer.
//
// Gates (all fail closed): the lead belongs to the tenant, is not rejected, is a company row, sits on a SETTLED website (identityOf) and
// is not held; the person is one of the lead's stored buyer-role targets (work-email-eligible.ts), re-derived here from stored rows;
// the address is on the lead's own site, printed on an https page of that site, and the name is not shared by two buyers on the lead.
// Nothing here creates a contact, a draft or a send: drafting stays on published addresses only (#899 boundary).
import type Database from 'better-sqlite3'
import { NON_COMPANY_REVIEW, counterpartySettledPath, counterpartySignal } from '../scan/find-contact-eligible.ts'
import { enrichmentsForLeads, type Enrichment } from '../connectors/store.ts'
import { sameSite } from '../connectors/sitecrawl.ts'
import { publishedDisplayCountry, publishedDisplayRows } from './published-display.ts'
import { publishedCandidateRowsForLeads, publishedNameKey, selectPublishedCandidate, type PublishedCandidateRow } from './email-pattern.ts'
import { identityOf } from '../scan/opportunity.ts'
import { countriesIn } from '../scan/countries.ts'
import { US_STATES } from '../scan/place-agreement.ts'
import { PUBLISHED_EMAIL_RE } from '../outreach/published-email.ts'
import { domainMatchesCompany, isWorkEmailFixtureLead, siteSettled, targetKey, TARGET_KEY_MAX, workEmailLeadEligible, workEmailTargets } from './work-email-eligible.ts'
import { currentnessHeld } from '../outreach/currentness.ts'
import { hasCompanyFirstBudget } from '../company-first/product-discovery.ts'
import { companyFirstDisplayQueries, companyFirstDisplayRow, missingDisplayTable, type CompanyFirstDisplayStored, type CompanyFirstPublishedDisplayRow } from './company-first-published-display.ts'
import { domainRelationship } from '../signals/domain-basis.ts'

export const WORK_EMAIL_STATUSES = ['pending', 'verified', 'published', 'unverified', 'not_found', 'not_us', 'rejected', 'error', 'uncertain'] as const
export type WorkEmailStatus = typeof WORK_EMAIL_STATUSES[number]
// A 'pending' row older than this belongs to a run that died (also the scan-side stale window that imports this constant).
export const PENDING_STALE_S = 120

// The table and its rows stay (no data is dropped); nothing in the product reads or writes them any more (#1036 / #1250).
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

export interface WorkEmailRow { target: string; status: WorkEmailStatus; provider: string | null; address: string | null; detail: string | null; source_url: string | null; checked_at: number | null; updated_at: number; mailbox_check?: string | null; mailbox_verifier?: string | null; mailbox_checked_at?: number | null }

// What the Leads page needs for every work-email block on it, read once with the list (#1182): the published address the company prints
// for each buyer, rebuilt on every read (#1036 / #1250: no stored provider answer, no guess).
export interface WorkEmailPageRead { providers: WorkEmailProviders; providers_by_lead: Record<string, WorkEmailProviders>; lookups: Record<string, WorkEmailRow[]>; guesses: Record<string, never[]> }
export function workEmailPageRead(db: Database.Database, tenantId: string, leads: { id: string }[]): WorkEmailPageRead {
  const ids = [...new Set(leads.map(l => l.id).filter(id => /^[a-f0-9]{24}$/.test(id)))]
  return { providers: PUBLISHED_ONLY_WORK_EMAIL_PROVIDERS, providers_by_lead: Object.fromEntries(ids.map(id => [id, PUBLISHED_ONLY_WORK_EMAIL_PROVIDERS])), lookups: strictPublishedWorkEmailsForLeads(db, tenantId, ids), guesses: {} }
}

// The same durable owner/job machine proof as ordinary Leads/Ready. Older
// native strict jobs intentionally retain their existing review behavior.
function markedWorkEmailHeld(db:Database.Database,tenantId:string,lead:LeadRow,now:number):boolean{
  if(!hasCompanyFirstBudget(lead.run_budget))return false
  try { return currentnessHeld(db,tenantId,lead.id,new Date(now*1000)) } catch { return true }
}

// The scan's places name the United States: each one either names it as its country or ends in a US state (name or postal code)
// and names no other country. "London", "Toronto, ON", "Remote", a bare "<City>, CA" or no place at all is not a US scope.
const usPlace = (w: string) => {
  const codes = countriesIn(w)
  if (codes.length) return codes.length === 1 && codes[0] === 'US'
  const last = (w.split(',').pop() ?? '').trim()
  // A bare "CA" is California or Canada ("Windsor, CA" is both): never a US scope. "California" or a country spelled out is.
  if (last.toUpperCase() === 'CA') return false
  return !!last && ((last.length === 2 && Object.hasOwn(US_STATES, last.toUpperCase())) || Object.values(US_STATES).includes(last.toLowerCase()))
}
const usScope = (where: string[]) => where.length > 0 && where.every(usPlace)

/** The company-first display rows with the same query and binding as companyFirstPublishedDisplayRows, read synchronously. */
export function companyFirstPublishedDisplayRowsSync(db: Database.Database, tenantId: string, leadIds: readonly string[], nowSeconds = Math.floor(Date.now() / 1000)): Record<string, CompanyFirstPublishedDisplayRow> {
  const out: Record<string, CompanyFirstPublishedDisplayRow> = {}
  try {
    for (const q of companyFirstDisplayQueries(tenantId, leadIds, nowSeconds)) {
      for (const row of db.prepare(q.sql).all(...q.params) as CompanyFirstDisplayStored[]) {
        const shown = companyFirstDisplayRow(row)
        if (!shown || domainRelationship(db, tenantId, row.lead_id, row.domain) !== 'established') continue
        out[row.lead_id] = shown
      }
    }
  } catch (e) { if (!missingDisplayTable(e)) throw e }
  return out
}

// A company-first crawl files the buyer's own address from their own card on the company page (company_first_published_email_display),
// not as a published candidate. On a US lead the same strict step also wrote the sender route for that exact address and page; only
// then is the pair this buyer's published candidate here, so Find work email gives what the scan already found. Callers pass only leads
// whose scan is scoped to the US (usScope).
function withUsCompanyFirst(db: Database.Database, tenantId: string, base: Record<string, PublishedCandidateRow[]>, leadIds: string[], now: number, known?: Record<string, Enrichment[]>): Record<string, PublishedCandidateRow[]> {
  if (!leadIds.length) return base
  const pairs = companyFirstPublishedDisplayRowsSync(db, tenantId, leadIds, now)
  const ids = Object.keys(pairs)
  if (!ids.length) return base
  const routes = known ?? enrichmentsForLeads(db, tenantId, ids)
  const out = { ...base }
  for (const id of ids) {
    const pair = pairs[id]
    const routed = (routes[id] ?? []).some(e => e.connector === 'sitecrawl' && e.kind === 'email' && e.value.toLowerCase() === pair.address.toLowerCase() && e.source_url === pair.source_url)
    if (routed) out[id] = [...(out[id] ?? []), { person: pair.person, address: pair.address.toLowerCase(), source_url: pair.source_url }]
  }
  return out
}

// Strict GET and page preload reconstruct the same response as POST, with no cached lookup rows.
// Fetch owned lead provenance, people/site data, and published candidates in bounded batches.
export function strictPublishedWorkEmailsForLeads(db: Database.Database, tenantId: string, leadIds: string[], now = Math.floor(Date.now() / 1000)): Record<string, WorkEmailRow[]> {
  const ids = [...new Set(leadIds.filter(id => /^[a-f0-9]{24}$/.test(id)))]
  const out: Record<string, WorkEmailRow[]> = {}
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200)
    const owned = db.prepare(`SELECT ${LEAD_COLS} FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? AND l.id IN (${part.map(() => '?').join(',')})`).all(tenantId, ...part) as LeadRow[]
    const strict = owned // #1036 / #1250: every scan reads published addresses only
    for(const l of strict) out[l.id] = [] // a held row shows nothing, never a stored lookup or a guess
    const readable = strict.filter(l => !markedWorkEmailHeld(db,tenantId,l,now))
    const strictIds = readable.map(l => l.id)
    const enriched = enrichmentsForLeads(db, tenantId, strictIds)
    const projected = readable.map(l => ({ l, ctx: workEmailTargetContext(l, enriched[l.id] ?? [], now) }))
    const companyFirstIds = new Set(readable.filter(l => hasCompanyFirstBudget(l.run_budget)).map(l => l.id))
    const usScoped = (id: string) => projected.some(r => r.l.id === id && r.ctx && usScope(r.ctx.where))
    const idsFor = (country: 'CA' | 'GB' | null) => projected.filter(r => r.ctx && publishedDisplayCountry(r.ctx.where) === country).map(r => r.l.id)
    const candidates = { ...withUsCompanyFirst(db, tenantId, publishedCandidateRowsForLeads(db, tenantId, idsFor(null)), idsFor(null).filter(id => companyFirstIds.has(id) && usScoped(id)), now, enriched),
      ...publishedDisplayRows(db, tenantId, 'CA', idsFor('CA')), ...publishedDisplayRows(db, tenantId, 'GB', idsFor('GB')) }
    for (const { l, ctx } of projected) {
      // #1177: a customer-mention row shows its published addresses when its own site is settled (ctx) and the
      // settled domain matches its company name, like the lookup.
      if ((!eligibleWorkEmailLead(l) && !(ctx && counterpartySettledPath(l, domainMatchesCompany(ctx.site, l.company)))) || isWorkEmailFixtureLead(l)) continue
      if (!ctx) continue
      out[l.id] = ctx.people.map(person => strictPublishedRow(targetKey(person), person.name, ctx, candidates[l.id] ?? [], now)).filter(r => r.status === 'published')
    }
  }
  return out
}

export interface WorkEmailProviders { apollo: boolean; pdl: boolean; pdlNeedsOptIn: boolean; mailboxCheck: boolean; publishedOnly?: boolean }
export const PUBLISHED_ONLY_WORK_EMAIL_PROVIDERS: WorkEmailProviders = { apollo: false, pdl: false, pdlNeedsOptIn: false, mailboxCheck: false, publishedOnly: true }

export type FindWorkEmailResult =
  | { status: 'lead_not_found' | 'not_eligible' | 'site_unsettled'; detail: string }
  | { status: WorkEmailStatus; row: WorkEmailRow; replayed: boolean }

interface LeadRow { id: string; scan_job_id: string; company: string; contact: string | null; quarantined_at: number | null; source_kind: string | null; human_confirmed_from: string | null; review_reason: string | null; icp: string | null; run_budget: string | null }

const LEAD_COLS = 'l.id, l.scan_job_id, l.company, l.contact, l.quarantined_at, l.source_kind, l.human_confirmed_from, l.review_reason, j.icp, j.run_budget'
const eligibleWorkEmailLead = (lead: LeadRow) => !lead.quarantined_at && !NON_COMPANY_REVIEW.includes(lead.review_reason ?? '') && workEmailLeadEligible(lead)

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
      ? 'Two buyers on this lead share this name, so the printed address cannot be tied to one of them.'
      : 'No address for this buyer is printed on the company website.' }
}

const domainOf = (address: string) => (address.split('@')[1] ?? '').toLowerCase()

type FindDeps = { fetchImpl?: typeof fetch; master?: Buffer; env?: Record<string, string | undefined>; now?: number }
// #1036 / #1250: the buyer's work email is only an address the company prints on its own website, filed under this person. No provider
// (Apollo, People Data Labs), mailbox check or learned-format guess runs, on any scan; nothing is stored, so a reload rebuilds the same answer.
export async function findWorkEmail(db: Database.Database, tenantId: string, leadId: string, target: unknown, deps: FindDeps = {}): Promise<FindWorkEmailResult> {
  const now = deps.now ?? Math.floor(Date.now() / 1000)
  if (typeof target !== 'string' || !target || target.length > TARGET_KEY_MAX) return { status: 'not_eligible', detail: 'no such person on this lead' }
  const lead = db.prepare(`SELECT ${LEAD_COLS}
    FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?`).get(leadId, tenantId) as LeadRow | undefined
  if (!lead) return { status: 'lead_not_found', detail: 'lead not found' }
  if (markedWorkEmailHeld(db,tenantId,lead,now)) return { status: 'not_eligible', detail: 'This lead remains held; no contact lookup ran.' }
  // #1036: a lead still in review may be looked up (the review is about the signal), except one held because its "company" is a
  // person's handle or the other side of a post (the cited page is about someone else, so the row is not established as this
  // company's lead; the same rule as the Leads page and Find contact). It fails closed even when a website was recorded.
  // #1177: a customer-mention row (counterparty_signal) is the one exception: it passes these gates and is refused below
  // unless its own site is settled (the target context), which establishes the company independently of the cited page.
  if (NON_COMPANY_REVIEW.includes(lead.review_reason ?? '') && lead.review_reason !== 'counterparty_signal') return { status: 'not_eligible', detail: 'this row is not a company' }
  if (lead.quarantined_at) return { status: 'not_eligible', detail: 'this lead was rejected' }
  const rows = enrichmentsForLeads(db, tenantId, [lead.id])[lead.id] ?? []
  const ctx = workEmailTargetContext(lead, rows, now)
  // #1177: the counterparty pass-through above only holds when the settled site is this company's own, judged
  // by the company name matching the domain - the same judgement the crawl made when it labelled the row. A
  // settled row naming another company is that company's crawl, and the lookup must not run on it.
  if (counterpartySignal(lead) && ctx && !domainMatchesCompany(ctx.site, lead.company)) return { status: 'not_eligible', detail: 'this row is not a company' }
  if (!workEmailLeadEligible(lead) && !counterpartySettledPath(lead, !!ctx)) return { status: 'not_eligible', detail: 'this row is not a company' }
  if (isWorkEmailFixtureLead(lead)) return { status: 'not_eligible', detail: 'a result must come from the company website' }
  if (!ctx) return { status: 'site_unsettled', detail: "the company's website is not settled yet, so an address on it cannot be checked" }
  const person = ctx.people.find(p => targetKey(p) === target)
  if (!person) return { status: 'not_eligible', detail: 'no such buyer-role person on this lead' }
  const country = publishedDisplayCountry(ctx.where)
  const candidates = country ? publishedDisplayRows(db, tenantId, country, [lead.id]) : withUsCompanyFirst(db, tenantId, publishedCandidateRowsForLeads(db, tenantId, [lead.id]), hasCompanyFirstBudget(lead.run_budget) && usScope(ctx.where) ? [lead.id] : [], now, { [lead.id]: rows })
  const row = strictPublishedRow(target, person.name, ctx, candidates[lead.id] ?? [], now)
  return { status: row.status, row, replayed: false }
}
