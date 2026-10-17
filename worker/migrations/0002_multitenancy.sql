-- Multitenancy (additive; 0001-created data is preserved and backfilled).
--
-- Tenants: one row per customer organization. All tenant-owned rows
-- (employees, memory, api_keys) carry tenant_id and every query filters on
-- it, so isolation is enforced by the schema, not just by route code.
CREATE TABLE IF NOT EXISTS tenants (
  tenant_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- API keys: per-tenant credentials for the /v1 API. The full key is shown to
-- the caller exactly once at issuance; only its SHA-256 digest is stored, so a
-- D1 leak does not leak usable credentials. key_preview (first 8 + last 4
-- characters) is kept so an operator can identify which key made a request
-- from logs without knowing the key itself.
CREATE TABLE IF NOT EXISTS api_keys (
  key_id      TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
  key_digest  TEXT NOT NULL UNIQUE,
  key_preview TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked_at  INTEGER
);

-- employees: 0001 had employee_name as the PRIMARY KEY, which made the same
-- employee name impossible across tenants. Recreate with a composite
-- (tenant_id, employee_name) primary key, carrying over all existing rows
-- under the default tenant below.
CREATE TABLE IF NOT EXISTS employees_new (
  tenant_id     TEXT NOT NULL REFERENCES tenants(tenant_id),
  employee_name TEXT NOT NULL,
  role          TEXT NOT NULL,
  goal          TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (tenant_id, employee_name)
);

-- The default tenant: the single-tenant rows that existed before
-- multitenancy are re-homed here, and the legacy DAZL_API_SECRET-guarded
-- routes operate on it (documented as deprecated in worker/MULTITENANCY.md).
-- OR IGNORE keeps a re-run of this migration inert instead of fatal.
INSERT OR IGNORE INTO tenants (tenant_id, name) VALUES ('default', 'Default (pre-multitenancy)');

INSERT INTO employees_new (tenant_id, employee_name, role, goal, created_at)
  SELECT 'default', employee_name, role, goal, created_at FROM employees;

DROP TABLE employees;
ALTER TABLE employees_new RENAME TO employees;

-- memory: append-only rows, no uniqueness constraints to change — a plain
-- column add with a default backfills every existing row to the default
-- tenant and keeps schema.test.ts's bare INSERT (no tenant_id) working.
ALTER TABLE memory ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_memory_tenant_employee ON memory (tenant_id, employee_name);
