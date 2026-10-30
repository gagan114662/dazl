-- Tenant export and deletion requests (lib/tenant/requests.ts, #359 part 2): the tenant asks, an operator carries
-- it out. Like every tenant-scoped table, it gets the deleted-tenant guard (0019).
CREATE TABLE tenant_requests (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('export','deletion')),
    status TEXT NOT NULL CHECK (status IN ('delivered','pending','withdrawn','executed','refused')),
    requested_at BIGINT NOT NULL,
    decided_at BIGINT,
    decided_by TEXT CHECK (decided_by IS NULL OR char_length(decided_by) <= 200),
    note TEXT CHECK (note IS NULL OR char_length(note) <= 300)
  );
CREATE INDEX tenant_requests_tenant ON tenant_requests (tenant_id, kind, status);

CREATE OR REPLACE FUNCTION dazl_guard_tomb_tenant_requests() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_tenant_requests ON tenant_requests;
CREATE TRIGGER tomb_tenant_requests BEFORE INSERT ON tenant_requests FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_tenant_requests();
