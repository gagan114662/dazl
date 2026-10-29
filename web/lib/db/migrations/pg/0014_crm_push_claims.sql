-- One claim per tenant, CRM provider and lead (lib/crm/index.ts, #365): taken before a native CRM create is sent, so
-- two requests or two workers can never both send it, and an unknown outcome blocks a retry until the user resolves it,
-- across restarts and key changes. attempt_id fences the request that holds the claim.
CREATE TABLE crm_push_claims (
  tenant_id   TEXT NOT NULL,
  destination TEXT NOT NULL,
  lead_id     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'failed', 'uncertain', 'resolved_created', 'resolved_not_created')),
  external_id TEXT,
  attempt_id  TEXT NOT NULL,
  claimed_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, destination, lead_id)
);
