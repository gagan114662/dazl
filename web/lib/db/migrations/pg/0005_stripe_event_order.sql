-- Stripe event ordering (lib/billing/stripe.ts): the created time of the last Stripe event that set a tenant's plan.
-- Stripe does not deliver events in order; an older event arriving later must not undo a newer one.
ALTER TABLE tenant_plans ADD COLUMN stripe_event_at BIGINT;
