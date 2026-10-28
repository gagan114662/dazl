-- Shared state for multiple app instances (docs/PLATFORM.md step 3): the rate limiter and named leases.
-- Same DDL as lib/db/platform-tables.ts after translation (test/pg-schema-drift.test.ts checks it).
CREATE TABLE rate_limits (
      key TEXT PRIMARY KEY CHECK (char_length(key) <= 300),
      count BIGINT NOT NULL,
      reset_at BIGINT NOT NULL
    );

CREATE INDEX rate_limits_reset ON rate_limits (reset_at);

CREATE TABLE app_leases (
      name TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    );
