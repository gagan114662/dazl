-- One self-enforcing claim per paid provider lookup (lib/connectors/store.ts, #382): the PRIMARY KEY decides the
-- race on any engine - two workers, two PG connections, or a stale-lease double-run can never both pay for the same
-- lookup. reserved -> ok/empty/rejected keeps the claim as the job's never-pay-twice memo; a transient settle
-- releases (deletes) it so a retriable failure may retry; a crash leaves 'reserved' and the replay fails closed
-- (uncertain, never a second payment). Audit history in connector_audit is never rewritten or deleted for this.
CREATE TABLE connector_claims (
  tenant_id   TEXT NOT NULL,
  connector   TEXT NOT NULL,
  scan_job_id TEXT NOT NULL,
  lookup      TEXT NOT NULL CHECK (char_length(lookup) <= 200),
  status      TEXT NOT NULL CHECK (status IN ('reserved','ok','empty','rejected')),
  claimed_at  BIGINT NOT NULL,
  settled_at  BIGINT,
  PRIMARY KEY (tenant_id, connector, scan_job_id, lookup)
);
