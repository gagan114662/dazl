import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { norm } from './store.ts'

// The consent ledger decides what automation is allowed per contact and channel.
// A row is proof: how consent was obtained, where the evidence is, when it expires.
// Any opt-out revokes every channel for that contact.
export const CONSENT_TTL_DAYS = 180 // CRTC guidance: an inquiry gives implied consent for 6 months (https://www.crtc.gc.ca/eng/com500/guide.htm)
export type Channel = 'email' | 'phone'

export function migrateLedger(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consent_ledger (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL,
      contact      TEXT NOT NULL,
      channel      TEXT NOT NULL CHECK (channel IN ('email','phone')),
      scope        TEXT NOT NULL CHECK (length(scope) <= 40),
      basis        TEXT NOT NULL CHECK (length(basis) <= 40),
      evidence_ref TEXT NOT NULL CHECK (length(evidence_ref) <= 200),
      granted_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      revoked_at   INTEGER,
      revoke_reason TEXT CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 60)
    );
    CREATE INDEX IF NOT EXISTS consent_ledger_lookup ON consent_ledger (tenant_id, contact, channel, scope);
  `)
}

export function grantConsent(db: Database.Database, tenantId: string, contact: string, g: { channel: Channel; scope: string; basis: string; evidenceRef: string; now?: number; ttlDays?: number }): void {
  const now = g.now ?? Math.floor(Date.now() / 1000)
  db.prepare('INSERT INTO consent_ledger (id, tenant_id, contact, channel, scope, basis, evidence_ref, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(randomBytes(12).toString('hex'), tenantId, norm(contact), g.channel, g.scope, g.basis, g.evidenceRef.slice(0, 200), now, now + (g.ttlDays ?? CONSENT_TTL_DAYS) * 86400)
}

export function revokeAll(db: Database.Database, tenantId: string, contact: string, reason: string, now = Math.floor(Date.now() / 1000)): void {
  db.prepare('UPDATE consent_ledger SET revoked_at = ?, revoke_reason = ? WHERE tenant_id = ? AND contact = ? AND revoked_at IS NULL').run(now, reason.slice(0, 60), tenantId, norm(contact))
}

export function hasConsent(db: Database.Database, tenantId: string, contact: string, channel: Channel, scope: string, now = Math.floor(Date.now() / 1000)): boolean {
  return !!db.prepare('SELECT 1 FROM consent_ledger WHERE tenant_id = ? AND contact = ? AND channel = ? AND scope = ? AND revoked_at IS NULL AND expires_at > ?').get(tenantId, norm(contact), channel, scope, now)
}
