// The tenant's own list of existing customers and open deals (#364): the one authority for "do not prospect this
// company". A person enters each entry explicitly (an "Already a customer" action, or the list in settings); nothing
// here is inferred from lead stages (booked, interested, rejected), free-text notes, a CRM connection or a CRM push,
// and there are no CRM reads. Future imports need explicit field/stage mappings, freshness and conflict handling of
// their own.
//   match: a stable canonical account id (lib/accounts/graph.ts) or a domain the tenant entered (normalized). A lead
//          matches only through its own resolved identity: linked to that account, or whose verified website is that
//          domain. An unknown, quarantined or unlinked identity matches nothing and stays unknown.
//   entries are never deleted: removing one stamps removed_at/removed_by, so every change is reversible and readable.
// Exclusion (holding a new first touch to a confirmed match, lib/accounts/cooldown.ts) applies only with
// DAZL_ACCOUNT_EXCLUSIONS=1; the list can be kept either way. Existing leads, their evidence and their drafts are never
// changed by an entry; the hold reason is shown instead.
// On the Db layer (both engines). Tenant scope: every statement is keyed by the tenant id.
import { randomBytes } from 'node:crypto'
import { asDb, type DbLike, type Tx, type TxBody } from '../db/client.ts'
import { normDomain } from './graph.ts'

export type RelationshipStatus = 'customer' | 'open_deal'
export const RELATIONSHIP_STATUSES: RelationshipStatus[] = ['customer', 'open_deal']
export interface Relationship { id: string; match_kind: 'account_id' | 'domain'; match_value: string; status: RelationshipStatus; source: string; actor: string; created_at: number; removed_at: number | null; removed_by: string | null; note: string | null }

export function migrateAccountRelationships(db: { exec(sql: string): unknown }): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_account_relationships (
      tenant_id TEXT NOT NULL, id TEXT NOT NULL,
      match_kind TEXT NOT NULL CHECK (match_kind IN ('account_id','domain')), match_value TEXT NOT NULL CHECK (length(match_value) <= 253),
      status TEXT NOT NULL CHECK (status IN ('customer','open_deal')),
      source TEXT NOT NULL CHECK (source IN ('manual')), actor TEXT NOT NULL CHECK (length(actor) <= 100),
      note TEXT CHECK (note IS NULL OR length(note) <= 300),
      created_at INTEGER NOT NULL, removed_at INTEGER, removed_by TEXT CHECK (removed_by IS NULL OR length(removed_by) <= 100),
      PRIMARY KEY (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS tenant_account_relationships_match ON tenant_account_relationships (tenant_id, match_kind, match_value);
  `)
}

export const exclusionsEnabled = (env: Record<string, string | undefined> = process.env) => env.DAZL_ACCOUNT_EXCLUSIONS === '1'

export class RelationshipError extends Error {
  code: 'invalid' | 'account_not_found' | 'not_found' | 'already_listed'
  constructor(code: RelationshipError['code']) { super(code); this.code = code }
}

const COLS = 'id, match_kind, match_value, status, source, actor, created_at, removed_at, removed_by, note'

// A person's explicit entry. An account is matched by its canonical id (it must be one of the tenant's live accounts);
// a domain by its normalized form. One live entry per match.
export async function addRelationship(d: DbLike, tenantId: string, input: { accountId?: string; domain?: string; status: RelationshipStatus; note?: string | null }, actor: string, now = Math.floor(Date.now() / 1000)): Promise<Relationship> {
  if (!RELATIONSHIP_STATUSES.includes(input.status)) throw new RelationshipError('invalid')
  const byAccount = typeof input.accountId === 'string' && input.accountId.length > 0
  const domain = byAccount ? null : normDomain(input.domain)
  if (!byAccount && !domain) throw new RelationshipError('invalid')
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 300) : null
  return asDb(d).tx(function* (t: Tx): TxBody<Relationship> {
    if (byAccount && !(yield* t.get("SELECT 1 AS k FROM tenant_accounts WHERE tenant_id = ? AND id = ? AND status = 'active'", [tenantId, input.accountId!]))) throw new RelationshipError('account_not_found')
    const kind = byAccount ? 'account_id' : 'domain', value = byAccount ? input.accountId! : domain!
    if (yield* t.get('SELECT 1 AS k FROM tenant_account_relationships WHERE tenant_id = ? AND match_kind = ? AND match_value = ? AND removed_at IS NULL', [tenantId, kind, value])) throw new RelationshipError('already_listed')
    const id = randomBytes(12).toString('hex')
    yield* t.run("INSERT INTO tenant_account_relationships (tenant_id, id, match_kind, match_value, status, source, actor, note, created_at) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?)", [tenantId, id, kind, value, input.status, actor.slice(0, 100), note, now])
    return (yield* t.get<Relationship>(`SELECT ${COLS} FROM tenant_account_relationships WHERE tenant_id = ? AND id = ?`, [tenantId, id]))!
  })
}

// Reversible: the entry stays, stamped with who removed it and when.
export async function removeRelationship(d: DbLike, tenantId: string, id: string, actor: string, now = Math.floor(Date.now() / 1000)): Promise<void> {
  const r = await asDb(d).run('UPDATE tenant_account_relationships SET removed_at = ?, removed_by = ? WHERE tenant_id = ? AND id = ? AND removed_at IS NULL', [now, actor.slice(0, 100), tenantId, id])
  if (r.changes !== 1) throw new RelationshipError('not_found')
}

export function listRelationships(d: DbLike, tenantId: string, opts: { includeRemoved?: boolean } = {}): Promise<Relationship[]> {
  return asDb(d).all<Relationship>(`SELECT ${COLS} FROM tenant_account_relationships WHERE tenant_id = ?${opts.includeRemoved ? '' : ' AND removed_at IS NULL'} ORDER BY created_at DESC, id`, [tenantId])
}

// The live entry a lead matches through its own resolved identity, or null (unknown). A lead that is not linked
// (quarantined, or not yet resolved) matches nothing.
export async function relationshipForLead(d: DbLike, tenantId: string, leadId: string): Promise<Relationship | null> {
  const db = asDb(d)
  const link = await db.get<{ account_id: string; domain: string | null; company_domain: string | null }>(
    `SELECT k.account_id, a.domain, l.company_domain FROM tenant_lead_links k
     JOIN tenant_accounts a ON a.tenant_id = k.tenant_id AND a.id = k.account_id
     JOIN leads l ON l.id = k.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = k.tenant_id
     WHERE k.tenant_id = ? AND k.lead_id = ? AND k.status = 'linked'`, [tenantId, leadId])
  if (!link) return null
  // An entry made on an account a person later merged into this one still names it.
  const merged = await db.all<{ id: string; domain: string | null }>("SELECT id, domain FROM tenant_accounts WHERE tenant_id = ? AND merged_into = ?", [tenantId, link.account_id])
  const ids = [link.account_id, ...merged.map(m => m.id)]
  const domains = [...new Set([normDomain(link.domain), normDomain(link.company_domain), ...merged.map(m => normDomain(m.domain))].filter((x): x is string => !!x))]
  const params = [tenantId, ...ids, ...domains]
  return (await db.get<Relationship>(`SELECT ${COLS} FROM tenant_account_relationships WHERE tenant_id = ? AND removed_at IS NULL
    AND ((match_kind = 'account_id' AND match_value IN (${ids.map(() => '?').join(',')}))${domains.length ? ` OR (match_kind = 'domain' AND match_value IN (${domains.map(() => '?').join(',')}))` : ''})
    ORDER BY created_at, id LIMIT 1`, params)) ?? null
}
