// The tenant's canonical account/contact graph (#364): one account per real company and one contact per real person,
// however many plays found them. Leads stay what they are (one play's observation, with its own evidence and source);
// each lead is LINKED to the canonical account and contact it is about, and every link, merge and split is recorded with
// the lead it came from, so provenance survives every change.
//
// Identity rules (conservative: a wrong merge is worse than a duplicate):
//   - account: the lead's verified company website (company_domain) is the strong key: the same domain is the same
//     account whatever the name says ("Acme" and "Acme Inc" on acme.example).
//   - without a verified website, the contact's email domain (not a consumer mailbox) stands in only when the company
//     name agrees with that account; a different name under the same email domain is held for review (quarantined).
//   - a name alone never merges: a name-only lead gets an account of its own, and is quarantined when another account of
//     the tenant already carries that name (same-name businesses are often unrelated).
//   - contact: the normalized email, within one account. The same email on a lead whose account does not resolve to the
//     contact's account is quarantined, never moved or merged.
// A quarantined link has no account or contact until a person decides (assignQuarantined). merge and split are explicit
// operations with history; nothing here merges two existing accounts on its own.
//
// On the Db layer (both engines). Tenant scope: every statement is keyed by the tenant id, and a lead is only read
// through the tenant's own scan_jobs.
import { randomBytes } from 'node:crypto'
import { asDb, type DbLike, type Tx, type TxBody } from '../db/client.ts'

export type LinkStatus = 'linked' | 'quarantined'
export type LinkBasis = 'company_domain' | 'email_domain' | 'name_only' | 'manual'
export interface LeadLink { lead_id: string; job_id: string; account_id: string | null; contact_id: string | null; status: LinkStatus; basis: LinkBasis | null; reason: string | null }

const CONSUMER = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.ca', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'web.de', 'mail.com', 'zoho.com', 'fastmail.com'])
const SUFFIX = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'gmbh', 'ag', 'plc', 'sa', 'srl', 'bv', 'pty', 'the'])

export const normDomain = (d: string | null | undefined): string | null => {
  const v = (d ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '').replace(/\.$/, '')
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) && v.length <= 253 ? v : null
}
export const normEmail = (e: string | null | undefined): string | null => {
  const v = (e ?? '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254 ? v : null
}
export const normName = (n: string | null | undefined): string | null => {
  const words = (n ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean)
  while (words.length > 1 && SUFFIX.has(words[words.length - 1])) words.pop()
  while (words.length > 1 && words[0] === 'the') words.shift()
  const v = words.join(' ')
  return v ? v.slice(0, 150) : null
}
const emailDomain = (email: string | null) => { const d = email?.split('@')[1] ?? null; return d && !CONSUMER.has(d) ? normDomain(d) : null }
const newId = () => randomBytes(12).toString('hex')

export function migrateAccountGraph(db: { exec(sql: string): unknown }): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_accounts (
      tenant_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL CHECK (length(name) <= 150), domain TEXT CHECK (domain IS NULL OR length(domain) <= 253),
      status TEXT NOT NULL CHECK (status IN ('active','merged')), merged_into TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE TABLE IF NOT EXISTS tenant_contacts (
      tenant_id TEXT NOT NULL, id TEXT NOT NULL, account_id TEXT NOT NULL, email TEXT NOT NULL CHECK (length(email) <= 254), name TEXT CHECK (name IS NULL OR length(name) <= 150),
      status TEXT NOT NULL CHECK (status IN ('active','merged')), merged_into TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, id)
    );
    -- Identity keys: a domain or an email names exactly one live entity of the tenant; a name may name several.
    CREATE TABLE IF NOT EXISTS tenant_identity_aliases (
      tenant_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('domain','email','name')), value TEXT NOT NULL CHECK (length(value) <= 254),
      entity_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, kind, value, entity_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tenant_identity_aliases_key ON tenant_identity_aliases (tenant_id, kind, value) WHERE kind IN ('domain','email');
    -- Each lead (one play's observation) and the canonical account/contact it is about; quarantined: held for a person.
    CREATE TABLE IF NOT EXISTS tenant_lead_links (
      tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL, job_id TEXT NOT NULL, account_id TEXT, contact_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('linked','quarantined')), basis TEXT CHECK (basis IS NULL OR basis IN ('company_domain','email_domain','name_only','manual')),
      reason TEXT CHECK (reason IS NULL OR length(reason) <= 200), linked_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, lead_id),
      CHECK (status = 'quarantined' OR account_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS tenant_lead_links_account ON tenant_lead_links (tenant_id, account_id);
    CREATE INDEX IF NOT EXISTS tenant_lead_links_contact ON tenant_lead_links (tenant_id, contact_id);
    -- Every link, quarantine, merge, split and assignment, with what it moved (detail) so it can be read back or undone.
    CREATE TABLE IF NOT EXISTS tenant_identity_history (
      tenant_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('link','quarantine','merge','split','assign')), actor TEXT NOT NULL CHECK (length(actor) <= 100),
      lead_id TEXT, account_id TEXT, detail TEXT NOT NULL CHECK (length(detail) <= 4000),
      PRIMARY KEY (tenant_id, id)
    );
  `)
}

interface LeadRow { id: string; job_id: string; company: string; name: string; contact: string | null; company_domain: string | null }

function* history(t: Tx, tenantId: string, at: number, action: string, actor: string, leadId: string | null, accountId: string | null, detail: object): TxBody<void> {
  yield* t.run('INSERT INTO tenant_identity_history (tenant_id, id, at, action, actor, lead_id, account_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, newId(), at, action, actor.slice(0, 100), leadId, accountId, JSON.stringify(detail).slice(0, 4000)])
}
function* aliasOwner(t: Tx, tenantId: string, kind: 'domain' | 'email', value: string): TxBody<string | null> {
  return (yield* t.get<{ entity_id: string }>('SELECT entity_id FROM tenant_identity_aliases WHERE tenant_id = ? AND kind = ? AND value = ?', [tenantId, kind, value]))?.entity_id ?? null
}
function* addAlias(t: Tx, tenantId: string, kind: 'domain' | 'email' | 'name', value: string, entityId: string, at: number): TxBody<void> {
  yield* t.run('INSERT INTO tenant_identity_aliases (tenant_id, kind, value, entity_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [tenantId, kind, value, entityId, at])
}
function* namesOf(t: Tx, tenantId: string, accountId: string): TxBody<Set<string>> {
  return new Set((yield* t.all<{ value: string }>("SELECT value FROM tenant_identity_aliases WHERE tenant_id = ? AND kind = 'name' AND entity_id = ?", [tenantId, accountId])).map(r => r.value))
}
function* createAccount(t: Tx, tenantId: string, name: string, domain: string | null, at: number): TxBody<string> {
  const id = newId()
  yield* t.run("INSERT INTO tenant_accounts (tenant_id, id, name, domain, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)", [tenantId, id, name.slice(0, 150), domain, at])
  if (domain) {
    // A concurrent sync took the domain first: this transaction rolls back and the lead is resolved again.
    const r = yield* t.run("INSERT INTO tenant_identity_aliases (tenant_id, kind, value, entity_id, created_at) VALUES (?, 'domain', ?, ?, ?) ON CONFLICT DO NOTHING", [tenantId, domain, id, at])
    if (r.changes !== 1) throw new AliasRace()
  }
  return id
}
// A concurrent sync wrote the same identity key or link first; the lead's transaction is retried.
class AliasRace extends Error {}

// One lead: where does it belong? Returns the link written (or the existing one: a link is decided once; later changes
// are merge, split or assign, each with history).
function* resolveOne(t: Tx, tenantId: string, l: LeadRow, at: number): TxBody<LeadLink> {
  const existing = yield* t.get<LeadLink>('SELECT lead_id, job_id, account_id, contact_id, status, basis, reason FROM tenant_lead_links WHERE tenant_id = ? AND lead_id = ?', [tenantId, l.id])
  if (existing) return existing
  const name = normName(l.company) ?? normName(l.name)
  const email = normEmail(l.contact)
  const site = normDomain(l.company_domain), mailDomain = emailDomain(email)
  const write = function* (link: Omit<LeadLink, 'lead_id' | 'job_id'>): TxBody<LeadLink> {
    // Another sync linked this lead meanwhile: roll back and read its link.
    const r = yield* t.run('INSERT INTO tenant_lead_links (tenant_id, lead_id, job_id, account_id, contact_id, status, basis, reason, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [tenantId, l.id, l.job_id, link.account_id, link.contact_id, link.status, link.basis, link.reason, at])
    if (r.changes !== 1) throw new AliasRace()
    yield* history(t, tenantId, at, link.status === 'linked' ? 'link' : 'quarantine', 'system', l.id, link.account_id, { job_id: l.job_id, basis: link.basis, reason: link.reason, contact_id: link.contact_id, company: l.company, domain: site ?? mailDomain, email })
    return { lead_id: l.id, job_id: l.job_id, ...link }
  }
  const quarantine = (basis: LinkBasis, reason: string) => write({ account_id: null, contact_id: null, status: 'quarantined', basis, reason })

  let account: string | null = null, basis: LinkBasis
  if (site) {
    basis = 'company_domain'
    account = (yield* aliasOwner(t, tenantId, 'domain', site)) ?? (yield* createAccount(t, tenantId, l.company || l.name, site, at))
  } else if (mailDomain) {
    basis = 'email_domain'
    const owner = yield* aliasOwner(t, tenantId, 'domain', mailDomain)
    if (owner) {
      // The email domain is only a stand-in for a website: it joins the account only when the name agrees.
      if (!name || !(yield* namesOf(t, tenantId, owner)).has(name)) return yield* quarantine(basis, 'email domain matches an account with another name')
      account = owner
    } else account = yield* createAccount(t, tenantId, l.company || l.name, mailDomain, at)
  } else {
    basis = 'name_only'
    if (!name) return yield* quarantine(basis, 'no company name, website or email')
    const same = yield* t.get<{ n: number }>("SELECT COUNT(*) AS n FROM tenant_identity_aliases a JOIN tenant_accounts c ON c.tenant_id = a.tenant_id AND c.id = a.entity_id AND c.status = 'active' WHERE a.tenant_id = ? AND a.kind = 'name' AND a.value = ?", [tenantId, name])
    if (Number(same?.n ?? 0) > 0) return yield* quarantine(basis, 'same name as another account, no website or email to tell them apart')
    account = yield* createAccount(t, tenantId, l.company || l.name, null, at)
  }
  if (name) yield* addAlias(t, tenantId, 'name', name, account, at)

  let contact: string | null = null
  if (email) {
    const owner = yield* aliasOwner(t, tenantId, 'email', email)
    if (owner) {
      const c = yield* t.get<{ account_id: string }>("SELECT account_id FROM tenant_contacts WHERE tenant_id = ? AND id = ? AND status = 'active'", [tenantId, owner])
      if (!c || c.account_id !== account) return yield* quarantine(basis, 'contact email belongs to another account')
      contact = owner
    } else {
      contact = newId()
      yield* t.run("INSERT INTO tenant_contacts (tenant_id, id, account_id, email, name, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)", [tenantId, contact, account, email, l.name ? l.name.slice(0, 150) : null, at])
      const r = yield* t.run("INSERT INTO tenant_identity_aliases (tenant_id, kind, value, entity_id, created_at) VALUES (?, 'email', ?, ?, ?) ON CONFLICT DO NOTHING", [tenantId, email, contact, at])
      if (r.changes !== 1) throw new AliasRace()
    }
  }
  return yield* write({ account_id: account, contact_id: contact, status: 'linked', basis, reason: null })
}

const LEAD_SQL = `SELECT l.id, l.scan_job_id AS job_id, l.company, l.name, l.contact, l.company_domain FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id`

// Links every lead of the tenant not yet linked, oldest first (the first sighting founds the account), at most `limit`
// per call. Each lead is its own transaction; a race with another sync on the same new domain or email is retried.
export async function syncAccountGraph(d: DbLike, tenantId: string, opts: { limit?: number; now?: number } = {}): Promise<{ linked: number; quarantined: number; remaining: boolean }> {
  const db = asDb(d)
  const at = opts.now ?? Math.floor(Date.now() / 1000), limit = opts.limit ?? 500
  const leads = await db.all<LeadRow>(`${LEAD_SQL} WHERE j.user_id = ? AND NOT EXISTS (SELECT 1 FROM tenant_lead_links k WHERE k.tenant_id = ? AND k.lead_id = l.id) ORDER BY l.created_at, l.id LIMIT ?`, [tenantId, tenantId, limit + 1])
  const out = { linked: 0, quarantined: 0, remaining: leads.length > limit }
  for (const l of leads.slice(0, limit)) {
    let link: LeadLink | undefined
    for (let attempt = 0; attempt < 3 && !link; attempt++) {
      try { link = await db.tx(function* (t: Tx) { return yield* resolveOne(t, tenantId, l, at) }) } catch (e) { if (!(e instanceof AliasRace) || attempt === 2) throw e }
    }
    if (link!.status === 'linked') out.linked++; else out.quarantined++
  }
  return out
}

export async function leadLink(d: DbLike, tenantId: string, leadId: string): Promise<LeadLink | null> {
  return (await asDb(d).get<LeadLink>('SELECT lead_id, job_id, account_id, contact_id, status, basis, reason FROM tenant_lead_links WHERE tenant_id = ? AND lead_id = ?', [tenantId, leadId])) ?? null
}

// The canonical contact an email resolves to, only when that is unambiguous: one live contact owns the email and every
// lead of the tenant carrying it is linked to that contact. Anything else (unknown, a lead not yet linked, a quarantined
// one) is null: the caller does not guess.
export async function contactForEmail(d: DbLike, tenantId: string, rawEmail: string): Promise<EmailContact | null> {
  return asDb(d).tx(function* (t: Tx) { return yield* contactForEmailTx(t, tenantId, rawEmail) })
}
export interface EmailContact { contact_id: string; account_id: string; lead_ids: string[] }
export function* contactForEmailTx(t: Tx, tenantId: string, rawEmail: string): TxBody<EmailContact | null> {
  const email = normEmail(rawEmail)
  if (!email) return null
  const owner = yield* t.get<{ id: string; account_id: string }>("SELECT c.id, c.account_id FROM tenant_identity_aliases a JOIN tenant_contacts c ON c.tenant_id = a.tenant_id AND c.id = a.entity_id AND c.status = 'active' WHERE a.tenant_id = ? AND a.kind = 'email' AND a.value = ?", [tenantId, email])
  if (!owner) return null
  const leads = yield* t.all<{ id: string; contact_id: string | null; status: string | null }>(`SELECT l.id, k.contact_id, k.status FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
    LEFT JOIN tenant_lead_links k ON k.tenant_id = ? AND k.lead_id = l.id
    WHERE j.user_id = ? AND l.contact IS NOT NULL AND lower(trim(l.contact)) = ? ORDER BY l.created_at, l.id`, [tenantId, tenantId, email])
  if (leads.length === 0 || leads.some(l => l.status !== 'linked' || l.contact_id !== owner.id)) return null
  return { contact_id: owner.id, account_id: owner.account_id, lead_ids: leads.map(l => l.id) }
}

// Every play's observation of one account, oldest first: the provenance view.
export async function accountLeads(d: DbLike, tenantId: string, accountId: string) {
  return asDb(d).all<{ lead_id: string; job_id: string; contact_id: string | null; basis: string | null; company: string; source_url: string; signal: string }>(
    `SELECT k.lead_id, k.job_id, k.contact_id, k.basis, l.company, l.source_url, l.signal FROM tenant_lead_links k
     JOIN leads l ON l.id = k.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = k.tenant_id
     WHERE k.tenant_id = ? AND k.account_id = ? AND k.status = 'linked' ORDER BY k.linked_at, k.lead_id`, [tenantId, accountId])
}

export class IdentityError extends Error {
  code: 'not_found' | 'not_active' | 'same_account' | 'not_quarantined'
  constructor(code: IdentityError['code']) { super(code); this.code = code }
}
function* activeAccount(t: Tx, tenantId: string, id: string): TxBody<{ id: string; domain: string | null }> {
  const a = yield* t.get<{ id: string; domain: string | null; status: string }>('SELECT id, domain, status FROM tenant_accounts WHERE tenant_id = ? AND id = ?', [tenantId, id])
  if (!a) throw new IdentityError('not_found')
  if (a.status !== 'active') throw new IdentityError('not_active')
  return a
}

// A person decided `drop` is the same company as `keep`: its leads, contacts and identity keys move to keep, drop is
// kept as 'merged' (pointing at keep), and the history row lists exactly what moved. Two contacts with the same email
// cannot exist (the email key is unique), so contacts move as they are.
export async function mergeAccounts(d: DbLike, tenantId: string, keep: string, drop: string, actor: string, now = Math.floor(Date.now() / 1000)): Promise<void> {
  if (keep === drop) throw new IdentityError('same_account')
  await asDb(d).tx(function* (t: Tx): TxBody<void> {
    yield* activeAccount(t, tenantId, keep); yield* activeAccount(t, tenantId, drop)
    const leads = (yield* t.all<{ lead_id: string }>('SELECT lead_id FROM tenant_lead_links WHERE tenant_id = ? AND account_id = ? ORDER BY lead_id', [tenantId, drop])).map(r => r.lead_id)
    const contacts = (yield* t.all<{ id: string }>("SELECT id FROM tenant_contacts WHERE tenant_id = ? AND account_id = ? AND status = 'active' ORDER BY id", [tenantId, drop])).map(r => r.id)
    const aliases = yield* t.all<{ kind: string; value: string }>('SELECT kind, value FROM tenant_identity_aliases WHERE tenant_id = ? AND entity_id = ? ORDER BY kind, value', [tenantId, drop])
    yield* t.run('UPDATE tenant_lead_links SET account_id = ? WHERE tenant_id = ? AND account_id = ?', [keep, tenantId, drop])
    yield* t.run("UPDATE tenant_contacts SET account_id = ? WHERE tenant_id = ? AND account_id = ? AND status = 'active'", [keep, tenantId, drop])
    // Name aliases both accounts already share stay single; the rest move.
    yield* t.run("DELETE FROM tenant_identity_aliases WHERE tenant_id = ? AND entity_id = ? AND kind = 'name' AND value IN (SELECT value FROM tenant_identity_aliases WHERE tenant_id = ? AND entity_id = ? AND kind = 'name')", [tenantId, drop, tenantId, keep])
    yield* t.run('UPDATE tenant_identity_aliases SET entity_id = ? WHERE tenant_id = ? AND entity_id = ?', [keep, tenantId, drop])
    yield* t.run("UPDATE tenant_accounts SET status = 'merged', merged_into = ? WHERE tenant_id = ? AND id = ?", [keep, tenantId, drop])
    yield* history(t, tenantId, now, 'merge', actor, null, keep, { dropped: drop, leads, contacts, aliases })
  })
}

// A person decided this lead is NOT the company it was linked to: it gets an account of its own (with its own name; the
// old account keeps its domain and email keys, which this lead's observation cannot claim), and its contact link is
// dropped (the contact's email stays with the old account). The history row records where it came from.
export async function splitLead(d: DbLike, tenantId: string, leadId: string, actor: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  return asDb(d).tx(function* (t: Tx): TxBody<string> {
    const link = yield* t.get<LeadLink>("SELECT lead_id, job_id, account_id, contact_id, status, basis, reason FROM tenant_lead_links WHERE tenant_id = ? AND lead_id = ? AND status = 'linked'", [tenantId, leadId])
    if (!link) throw new IdentityError('not_found')
    const l = yield* t.get<{ company: string; name: string }>(`SELECT l.company, l.name FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?`, [leadId, tenantId])
    if (!l) throw new IdentityError('not_found')
    const id = yield* createAccount(t, tenantId, l.company || l.name, null, now)
    const name = normName(l.company) ?? normName(l.name)
    if (name) yield* addAlias(t, tenantId, 'name', name, id, now)
    yield* t.run("UPDATE tenant_lead_links SET account_id = ?, contact_id = NULL, basis = 'manual' WHERE tenant_id = ? AND lead_id = ?", [id, tenantId, leadId])
    yield* history(t, tenantId, now, 'split', actor, leadId, id, { from_account: link.account_id, from_contact: link.contact_id, from_basis: link.basis })
    return id
  })
}

// A person resolved a quarantined lead onto an account. Its contact is linked only when the email is free or already that
// account's contact; otherwise the lead joins the account without one.
export async function assignQuarantined(d: DbLike, tenantId: string, leadId: string, accountId: string, actor: string, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await asDb(d).tx(function* (t: Tx): TxBody<void> {
    const link = yield* t.get<LeadLink>('SELECT lead_id, job_id, account_id, contact_id, status, basis, reason FROM tenant_lead_links WHERE tenant_id = ? AND lead_id = ?', [tenantId, leadId])
    if (!link) throw new IdentityError('not_found')
    if (link.status !== 'quarantined') throw new IdentityError('not_quarantined')
    yield* activeAccount(t, tenantId, accountId)
    const l = yield* t.get<{ contact: string | null; name: string }>(`SELECT l.contact, l.name FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?`, [leadId, tenantId])
    if (!l) throw new IdentityError('not_found')
    const email = normEmail(l.contact)
    let contact: string | null = null
    if (email) {
      const owner = yield* aliasOwner(t, tenantId, 'email', email)
      if (owner) {
        const c = yield* t.get<{ account_id: string }>("SELECT account_id FROM tenant_contacts WHERE tenant_id = ? AND id = ? AND status = 'active'", [tenantId, owner])
        if (c?.account_id === accountId) contact = owner
      } else {
        contact = newId()
        yield* t.run("INSERT INTO tenant_contacts (tenant_id, id, account_id, email, name, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)", [tenantId, contact, accountId, email, l.name ? l.name.slice(0, 150) : null, now])
        yield* addAlias(t, tenantId, 'email', email, contact, now)
      }
    }
    yield* t.run("UPDATE tenant_lead_links SET account_id = ?, contact_id = ?, status = 'linked', basis = 'manual', reason = NULL WHERE tenant_id = ? AND lead_id = ?", [accountId, contact, tenantId, leadId])
    yield* history(t, tenantId, now, 'assign', actor, leadId, accountId, { from_reason: link.reason, from_basis: link.basis, contact_id: contact })
  })
}
