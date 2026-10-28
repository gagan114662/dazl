// Loaded after test/helpers/net-fence.ts in a smoke server (test/smoke/billing.smoke.mjs): the fence deletes every
// *SECRET*/*KEY* variable, so the smoke's TEST-MODE Stripe values arrive under neutral names and are put back here.
// They are generated per run by the smoke itself; no real Stripe value is ever involved.
if (process.env.SMOKE_STRIPE_WHSEC) process.env.STRIPE_WEBHOOK_SECRET = process.env.SMOKE_STRIPE_WHSEC
if (process.env.SMOKE_STRIPE_SK) process.env.STRIPE_SECRET_KEY = process.env.SMOKE_STRIPE_SK
