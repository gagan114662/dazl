-- Stripe event ordering (lib/billing/stripe.ts): the created time of the last Stripe event that set a tenant's plan.
-- Stripe does not deliver events in order; an older event arriving later must not undo a newer one.
ALTER TABLE tenant_plans ADD COLUMN stripe_event_at BIGINT;
-- A same-second tie Stripe has not settled yet: that second, until a read of the subscription settles it.
ALTER TABLE tenant_plans ADD COLUMN stripe_reconcile_at BIGINT;

-- Subscriptions Stripe has ended (deleted, canceled, incomplete_expired). Ending is final in Stripe (a resubscribe is a
-- new subscription id), so an ended id never upgrades a tenant again, even from an event of the same second.
CREATE TABLE stripe_ended_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      ended_at BIGINT
    );
