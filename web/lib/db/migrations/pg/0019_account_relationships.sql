-- The tenant's own customer / open-deal list (lib/accounts/relationships.ts, #364): explicit entries by a person, matched
-- by canonical account id or a domain the tenant entered; removal stamps removed_at/removed_by (reversible).
CREATE TABLE tenant_account_relationships (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL,
  match_kind TEXT NOT NULL CHECK (match_kind IN ('account_id','domain')), match_value TEXT NOT NULL CHECK (char_length(match_value) <= 253),
  status TEXT NOT NULL CHECK (status IN ('customer','open_deal')),
  source TEXT NOT NULL CHECK (source IN ('manual')), actor TEXT NOT NULL CHECK (char_length(actor) <= 100),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 300),
  created_at BIGINT NOT NULL, removed_at BIGINT, removed_by TEXT CHECK (removed_by IS NULL OR char_length(removed_by) <= 100),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX tenant_account_relationships_match ON tenant_account_relationships (tenant_id, match_kind, match_value);
