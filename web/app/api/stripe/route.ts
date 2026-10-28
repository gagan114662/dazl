// Stripe's webhook endpoint at /api/stripe: the same handler as /api/billing/webhook (lib/billing/stripe.ts), so either
// URL can be configured in the Stripe dashboard. Authenticity comes only from the signature over the raw body; with no
// STRIPE_WEBHOOK_SECRET the endpoint is off (503).
export { POST } from '@/app/api/billing/webhook/route'
