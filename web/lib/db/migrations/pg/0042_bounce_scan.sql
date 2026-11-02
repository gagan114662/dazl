-- Bounce handling (#415): per-send bounce ledger (the dedup unit is the original send + recipient, never the
-- Gmail notice id) and the separate, exact-version consent for the delivery-failure scan. Next number on this
-- branch; main already carries 0026-0028, so this file is RENUMBERED at merge reconcile (as #512's was).
CREATE TABLE bounce_records (
      tenant_id TEXT NOT NULL, outreach_message_id TEXT NOT NULL, recipient TEXT NOT NULL,
      status TEXT NOT NULL, source TEXT NOT NULL, source_gmail_id TEXT, created_at BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, outreach_message_id, recipient)
    );

CREATE TABLE mail_bounce_scan_consent (tenant_id TEXT PRIMARY KEY, version TEXT NOT NULL, accepted_at BIGINT NOT NULL DEFAULT (CAST(floor(extract(epoch from now())) AS BIGINT)));
