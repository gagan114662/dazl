-- The subscription's status as Stripe last reported it (lib/billing/stripe.ts), e.g. past_due after a failed payment
-- while Stripe retries. The plan stays the entitlement; this column says why.
ALTER TABLE tenant_plans ADD COLUMN subscription_status TEXT;
