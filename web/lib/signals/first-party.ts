// Consent-aware first-party demand signals (#390). Accepts events the SELLER's own systems send (a form / demo request, a product event, an optional company-level visitor
// event) and turns them into tenant-scoped, deduped leads with source, time and identity confidence. Rules: events are bound to a tenant AND a registered domain, signed
// (HMAC over tenant|domain|ts|nonce|body), time-windowed and replay-protected; collection is off unless the tenant enabled it, and opt-out disables it (and purges on request);
// a visitor event is ACCOUNT-level only - residential / VPN / ISP / unresolved traffic stays unknown and creates nothing; an account visit is never "a named person visited",
// and employees at a visiting company are not the visitor. A person is linked only when the form itself carried that person's own email. This module installs no tracking:
// it only validates what an authorized sender posts. Db layer (SQLite + Postgres); the secret and the IP->organisation resolver are injected.
import { createHmac, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db } from '../db/client.ts'

export function migrateFirstParty(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fp_settings (
      tenant_id TEXT PRIMARY KEY,
      collection_enabled INTEGER NOT NULL DEFAULT 0,
      visitor_enabled INTEGER NOT NULL DEFAULT 0,
      retention_days INTEGER NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 730),
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fp_domains (
      tenant_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      PRIMARY KEY (tenant_id, domain)
    );
    CREATE TABLE IF NOT EXISTS fp_nonces (
      tenant_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, nonce)
    );
    CREATE TABLE IF NOT EXISTS fp_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('form','demo_request','product_event','visitor')),
      account_key TEXT NOT NULL,
      company TEXT,
      person_email TEXT,
      identity_confidence INTEGER NOT NULL CHECK (identity_confidence BETWEEN 0 AND 100),
      level TEXT NOT NULL CHECK (level IN ('person','account')),
      occurred_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      dedup_key TEXT NOT NULL,
      UNIQUE (tenant_id, dedup_key)
    );
    CREATE INDEX IF NOT EXISTS fp_events_tenant ON fp_events (tenant_id, occurred_at);`)
}

export type Kind = 'form' | 'demo_request' | 'product_event' | 'visitor'
export interface Incoming { site: string; kind: Kind; ts: number; nonce: string; body: { company?: string; company_domain?: string; email?: string; name?: string; ip?: string; event?: string } }
export type Reject = 'collection_disabled' | 'visitor_disabled' | 'unknown_domain' | 'bad_signature' | 'stale' | 'replay' | 'malformed' | 'unresolved_visitor' | 'not_a_business' | 'no_identity'
export type Outcome = { ok: true; created: boolean; id: string; level: 'person' | 'account'; identity_confidence: number } | { ok: false; reason: Reject }
export interface Deps { now: number; secretFor: (tenantId: string, domain: string) => string | null; resolveOrg?: (ip: string) => Promise<{ kind: 'business' | 'residential' | 'vpn' | 'isp' | 'unknown'; company?: string; domain?: string } | null> }
export const WINDOW_S = 300

const host = (d: string) => d.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0]
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
export const signatureFor = (secret: string, tenantId: string, e: Incoming) => createHmac('sha256', secret).update([tenantId, host(e.site), e.kind, e.ts, e.nonce, JSON.stringify(e.body)].join('|')).digest('hex')
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com', 'live.com', 'qq.com'])
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})$/

export async function setConsent(db: Db, tenantId: string, s: { collection: boolean; visitor?: boolean; retentionDays?: number }, now: number): Promise<void> {
  const days = Math.min(730, Math.max(1, Math.floor(s.retentionDays ?? 90)))
  await db.run('INSERT INTO fp_settings (tenant_id, collection_enabled, visitor_enabled, retention_days, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant_id) DO UPDATE SET collection_enabled = excluded.collection_enabled, visitor_enabled = excluded.visitor_enabled, retention_days = excluded.retention_days, updated_at = excluded.updated_at',
    [tenantId, s.collection ? 1 : 0, s.collection && s.visitor ? 1 : 0, days, now])   // opting out of collection also switches visitor events off
}
export async function registerDomain(db: Db, tenantId: string, domain: string): Promise<void> {
  await db.run('INSERT INTO fp_domains (tenant_id, domain) VALUES (?, ?) ON CONFLICT DO NOTHING', [tenantId, host(domain)])
}

export async function ingest(db: Db, tenantId: string, e: Incoming, signature: string, deps: Deps): Promise<Outcome> {
  if (!e || typeof e.site !== 'string' || !['form', 'demo_request', 'product_event', 'visitor'].includes(e.kind) || !Number.isFinite(e.ts) || typeof e.nonce !== 'string' || e.nonce.length < 8 || e.nonce.length > 80 || typeof e.body !== 'object' || !e.body || typeof signature !== 'string') return { ok: false, reason: 'malformed' }
  const s = await db.get<{ collection_enabled: number; visitor_enabled: number }>('SELECT collection_enabled, visitor_enabled FROM fp_settings WHERE tenant_id = ?', [tenantId])
  if (!s || !Number(s.collection_enabled)) return { ok: false, reason: 'collection_disabled' }
  const site = host(e.site)
  if (!(await db.get('SELECT 1 AS x FROM fp_domains WHERE tenant_id = ? AND domain = ?', [tenantId, site]))) return { ok: false, reason: 'unknown_domain' }   // bound to the tenant's own registered domain
  const secret = deps.secretFor(tenantId, site)
  if (!secret || !same(signature, signatureFor(secret, tenantId, e))) return { ok: false, reason: 'bad_signature' }
  if (Math.abs(deps.now - e.ts) > WINDOW_S) return { ok: false, reason: 'stale' }
  const n = await db.run('INSERT INTO fp_nonces (tenant_id, nonce, seen_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [tenantId, e.nonce, deps.now])
  if (n.changes !== 1) return { ok: false, reason: 'replay' }
  let company = (e.body.company ?? '').trim().slice(0, 120), domain = host(e.body.company_domain ?? ''), email: string | null = null, level: 'person' | 'account' = 'account', conf = 0
  if (e.kind === 'visitor') {
    if (!Number(s.visitor_enabled)) return { ok: false, reason: 'visitor_disabled' }
    const org = e.body.ip && deps.resolveOrg ? await deps.resolveOrg(e.body.ip) : null
    if (!org || org.kind !== 'business' || (!org.domain && !org.company)) return { ok: false, reason: org && org.kind !== 'unknown' ? 'not_a_business' : 'unresolved_visitor' }   // residential / VPN / ISP stay unknown
    company = (org.company ?? '').slice(0, 120); domain = host(org.domain ?? ''); conf = org.domain ? 55 : 35   // an account-level guess, never a person
  } else {
    const m = e.body.email ? EMAIL.exec(e.body.email.trim()) : null
    if (m) { email = e.body.email!.trim().toLowerCase(); level = 'person'; const ed = m[1].toLowerCase(); if (!domain && !FREE_MAIL.has(ed)) domain = ed; conf = FREE_MAIL.has(ed) ? 40 : 80 }   // the person acted themselves (their own form)
    else if (e.kind === 'product_event' && (domain || company)) conf = domain ? 70 : 45
    if (!domain && !company && !email) return { ok: false, reason: 'no_identity' }
    if (e.kind !== 'product_event' && !email && !domain) conf = 30
  }
  const account = domain.includes('.') ? `d:${domain}` : company ? `n:${slug(company)}` : email ? `p:${email}` : ''   // a free-mail sender with no company is a person-keyed lead, not an account
  if (!account) return { ok: false, reason: 'no_identity' }
  const day = Math.floor(e.ts / 86400)
  const dedup = `${e.kind}|${account}|${email ?? ''}|${day}`   // one lead per account (and person) per kind per day
  const id = `fp_${deps.now.toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const r = await db.run('INSERT INTO fp_events (id, tenant_id, domain, kind, account_key, company, person_email, identity_confidence, level, occurred_at, received_at, dedup_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, dedup_key) DO NOTHING',
    [id, tenantId, site, e.kind, account, company || null, email, conf, level, e.ts, deps.now, dedup])
  if (r.changes === 1) return { ok: true, created: true, id, level, identity_confidence: conf }
  const ex = await db.get<{ id: string; level: 'person' | 'account'; identity_confidence: number }>('SELECT id, level, identity_confidence FROM fp_events WHERE tenant_id = ? AND dedup_key = ?', [tenantId, dedup])
  return { ok: true, created: false, id: ex!.id, level: ex!.level, identity_confidence: Number(ex!.identity_confidence) }
}

export interface FirstPartyLead { id: string; company: string | null; account_key: string; source: 'first_party'; kind: Kind; level: 'person' | 'account'; person_email: string | null; identity_confidence: number; occurred_at: number; claim: string }
export async function leadsFor(db: Db, tenantId: string, sinceS = 0): Promise<FirstPartyLead[]> {
  const rows = await db.all<{ id: string; company: string | null; account_key: string; kind: Kind; level: 'person' | 'account'; person_email: string | null; identity_confidence: number; occurred_at: number }>('SELECT id, company, account_key, kind, level, person_email, identity_confidence, occurred_at FROM fp_events WHERE tenant_id = ? AND occurred_at >= ? ORDER BY occurred_at DESC', [tenantId, sinceS])
  return rows.map(r => ({ ...r, identity_confidence: Number(r.identity_confidence), occurred_at: Number(r.occurred_at), source: 'first_party' as const,
    claim: r.kind === 'visitor' ? 'Someone at this company visited your site (account-level; not a named person, not an employee of this company in particular)' : r.level === 'person' ? `This person submitted your ${r.kind === 'demo_request' ? 'demo request' : r.kind === 'form' ? 'form' : 'product event'}` : `Activity from this account (${r.kind}); no person identified` }))
}
// Opt-out stops collection (setConsent) and, when asked, erases what was collected. Retention purges anything older than the tenant's window.
export async function purge(db: Db, tenantId: string, o: { all?: boolean }, now: number): Promise<number> {
  const s = await db.get<{ retention_days: number }>('SELECT retention_days FROM fp_settings WHERE tenant_id = ?', [tenantId])
  const cutoff = o.all ? Number.MAX_SAFE_INTEGER : now - Number(s?.retention_days ?? 90) * 86400
  const r = await db.run('DELETE FROM fp_events WHERE tenant_id = ? AND received_at < ?', [tenantId, cutoff])
  await db.run('DELETE FROM fp_nonces WHERE tenant_id = ? AND seen_at < ?', [tenantId, now - WINDOW_S * 2])
  return r.changes
}
