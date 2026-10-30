-- The tenant's canonical account/contact graph (lib/accounts/graph.ts, #364): accounts, contacts, identity keys, each
-- lead's link to them, and the history of every link, quarantine, merge, split and assignment.
CREATE TABLE tenant_accounts (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL CHECK (char_length(name) <= 150), domain TEXT CHECK (domain IS NULL OR char_length(domain) <= 253),
  status TEXT NOT NULL CHECK (status IN ('active','merged')), merged_into TEXT, created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE tenant_contacts (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, account_id TEXT NOT NULL, email TEXT NOT NULL CHECK (char_length(email) <= 254), name TEXT CHECK (name IS NULL OR char_length(name) <= 150),
  status TEXT NOT NULL CHECK (status IN ('active','merged')), merged_into TEXT, created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE tenant_identity_aliases (
  tenant_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('domain','email','name')), value TEXT NOT NULL CHECK (char_length(value) <= 254),
  entity_id TEXT NOT NULL, created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, kind, value, entity_id)
);
CREATE UNIQUE INDEX tenant_identity_aliases_key ON tenant_identity_aliases (tenant_id, kind, value) WHERE kind IN ('domain','email');
CREATE TABLE tenant_lead_links (
  tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL, job_id TEXT NOT NULL, account_id TEXT, contact_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('linked','quarantined')), basis TEXT CHECK (basis IS NULL OR basis IN ('company_domain','email_domain','name_only','manual')),
  reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 200), linked_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, lead_id),
  CHECK (status = 'quarantined' OR account_id IS NOT NULL)
);
CREATE INDEX tenant_lead_links_account ON tenant_lead_links (tenant_id, account_id);
CREATE INDEX tenant_lead_links_contact ON tenant_lead_links (tenant_id, contact_id);
CREATE TABLE tenant_identity_history (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, at BIGINT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('link','quarantine','merge','split','assign')), actor TEXT NOT NULL CHECK (char_length(actor) <= 100),
  lead_id TEXT, account_id TEXT, detail TEXT NOT NULL CHECK (char_length(detail) <= 4000),
  PRIMARY KEY (tenant_id, id)
);
-- The canonical contact a Cal.com booking resolved to (lib/calcom/index.ts).
ALTER TABLE calcom_bookings ADD COLUMN contact_id TEXT;
