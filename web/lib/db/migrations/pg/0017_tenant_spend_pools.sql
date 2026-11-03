-- Owner spend pools (lib/llm/spend-pool.ts, #363): one row per owner per UTC day ('d:YYYY-MM-DD') and per UTC month
-- ('m:YYYY-MM'). reserved_usd is what the limit is checked against (reservations plus settled costs); reported_usd is
-- the sum the vendor itself reported. Reservations raise reserved_usd only WHERE it still fits, under the row lock.
CREATE TABLE tenant_spend_pools (
    tenant_id TEXT NOT NULL, period TEXT NOT NULL CHECK (char_length(period) <= 12),
    reserved_usd DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0), reported_usd DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (reported_usd >= 0),
    calls BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, period)
  );
