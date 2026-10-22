import type Database from 'better-sqlite3'

// Association with the lead/evidence reviewed at approval, never causal conversion credit.
// No message body, recipient address or reply text is duplicated here.
export function migrateAttribution(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS outreach_signal_context (
    message_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    scan_job_id TEXT NOT NULL,
    signal TEXT,
    signals_json TEXT,
    signal_kind TEXT,
    source_kind TEXT,
    source_url TEXT,
    collectors_json TEXT,
    captured_at INTEGER NOT NULL
  )`)
}

export function snapshotSignalContext(db: Database.Database, tenantId: string, messageId: string, now = Math.floor(Date.now()/1000)): void {
  const lead = db.prepare(`SELECT l.id,l.scan_job_id,l.signal,l.signals,l.signal_kind,l.source_kind,l.source_url
    FROM outreach_messages m JOIN leads l ON l.id=m.lead_id JOIN scan_jobs j ON j.id=l.scan_job_id
    WHERE m.id=? AND m.tenant_id=? AND j.user_id=?`).get(messageId,tenantId,tenantId) as {
      id:string; scan_job_id:string; signal:string|null; signals:string|null; signal_kind:string|null; source_kind:string|null; source_url:string|null
    } | undefined
  if (!lead) return // no guessed association if ownership or the lead is missing
  const hasSources = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lead_sources'").get()
  const collectors = hasSources ? (db.prepare('SELECT DISTINCT collector FROM lead_sources WHERE lead_id=? ORDER BY collector').all(lead.id) as {collector:string}[]).map(s=>s.collector) : []
  db.prepare(`INSERT INTO outreach_signal_context
    (message_id,tenant_id,lead_id,scan_job_id,signal,signals_json,signal_kind,source_kind,source_url,collectors_json,captured_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET
    lead_id=excluded.lead_id,scan_job_id=excluded.scan_job_id,signal=excluded.signal,signals_json=excluded.signals_json,
    signal_kind=excluded.signal_kind,source_kind=excluded.source_kind,source_url=excluded.source_url,
    collectors_json=excluded.collectors_json,captured_at=excluded.captured_at
    WHERE outreach_signal_context.tenant_id=excluded.tenant_id`)
    .run(messageId,tenantId,lead.id,lead.scan_job_id,lead.signal,lead.signals,lead.signal_kind,lead.source_kind,lead.source_url,collectors.length ? JSON.stringify(collectors) : null,now)
}

// Read-only, tenant-scoped. NULL context is intentional for historical/unapproved
// messages. Existing lead_id remains available but is not a send-time snapshot.
export function messageSignalContext(db: Database.Database, tenantId: string, messageId: string) {
  return db.prepare(`SELECT m.id AS message_id,m.lead_id,m.status,m.test,
    c.scan_job_id,c.signal,c.signals_json,c.signal_kind,c.source_kind,c.source_url,c.collectors_json,c.captured_at
    FROM outreach_messages m LEFT JOIN outreach_signal_context c ON c.message_id=m.id AND c.tenant_id=m.tenant_id
    WHERE m.tenant_id=? AND m.id=?`).get(tenantId,messageId) ?? null
}
export function replySignalContexts(db: Database.Database, tenantId: string, gmailId: string) {
  return db.prepare(`SELECT r.gmail_id,r.thread_id,r.classification,r.received_at,r.outreach_message_id,
    m.lead_id,m.test,c.scan_job_id,c.signal,c.signals_json,c.signal_kind,c.source_kind,c.source_url,c.collectors_json,c.captured_at
    FROM inbound_messages r LEFT JOIN outreach_messages m ON m.id=r.outreach_message_id AND m.tenant_id=r.tenant_id
    LEFT JOIN outreach_signal_context c ON c.message_id=m.id AND c.tenant_id=m.tenant_id
    WHERE r.tenant_id=? AND r.gmail_id=?`).get(tenantId,gmailId) ?? null
}
