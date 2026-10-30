// Published plan prices: the landing page and the product truth record (lib/product-truth.ts) read these, so a price
// is stated in one place. Prices exclude AI usage: every plan runs on the tenant's own model key, billed by its provider.
export const PLAN_PRICES_USD_MONTH = { free: 0, pro: 49 } as const
