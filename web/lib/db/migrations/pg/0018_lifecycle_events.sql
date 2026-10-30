-- Dazl's own acquisition funnel (lib/growth/lifecycle.ts, #404): append-only lifecycle events the product writes when
-- they happen (first-party sign-up source, Stripe payments, failures, refunds, subscription ends). One row per kind and ref.
CREATE TABLE lifecycle_events (
    kind TEXT NOT NULL CHECK (kind IN ('signup','payment_succeeded','payment_failed','refund','subscription_ended')),
    ref TEXT NOT NULL CHECK (char_length(ref) BETWEEN 1 AND 200),
    tenant_id TEXT NOT NULL,
    occurred_at BIGINT NOT NULL,
    amount_cents BIGINT,
    invoice TEXT,
    full_refund BIGINT,
    source TEXT CHECK (source IS NULL OR char_length(source) <= 40),
    service_periods TEXT CHECK (service_periods IS NULL OR char_length(service_periods) <= 4000),
    PRIMARY KEY (kind, ref)
  );
CREATE INDEX lifecycle_events_tenant ON lifecycle_events (tenant_id, kind);
