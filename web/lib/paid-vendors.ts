// Gagan's rule (15 Nov 2026 03:38, via Hermes, Refs #1099): no paid third-party API in dazl's default path except Claude.
// These vendors cost money per call (on the operator's key or on a tenant's own key) and are OFF unless the operator names them in
// DAZL_PAID_VENDORS (comma-separated, e.g. "apollo,pdl"). Every call site checks paidVendorOn() BEFORE it reads a key or builds a
// request, and records why it did not call (paidVendorOffNote) instead of failing silently. Free replacements:
//   apollo / pdl   -> names from the company's own team / about / contact / press pages (the research engine's company.ts did this; deleted in #1393);
//   zerobounce     -> no mailbox check: a pattern-derived address stays "unverified", with a free MX lookup of its domain;
//   openai         -> scans run on Claude (an OpenAI key is not used for scans);
//   jina           -> our own fetch of the page (lib/scan/fetch-page.ts).
// TinyFish (search / fetch) and the OpenRouter free decider are not on this list: TinyFish runs inside its free allowance and the
// decider is a free model; both are governed by their own caps.
export const PAID_VENDORS = ['apollo', 'pdl', 'zerobounce', 'openai', 'jina'] as const
export type PaidVendor = typeof PAID_VENDORS[number]

const NAMES: Record<PaidVendor, string> = { apollo: 'Apollo', pdl: 'People Data Labs', zerobounce: 'ZeroBounce', openai: 'OpenAI', jina: 'Jina Reader' }

export function paidVendorsAllowed(env: Record<string, string | undefined> = process.env): Set<PaidVendor> {
  // an operator setting of the process: a call's own env (a test's, a staging fake's) that does not name it does not turn it off
  const want = (env.DAZL_PAID_VENDORS ?? process.env.DAZL_PAID_VENDORS ?? '').toLowerCase().split(',').map(s => s.trim())
  return new Set(PAID_VENDORS.filter(v => want.includes(v)))
}

export const paidVendorOn = (v: PaidVendor, env: Record<string, string | undefined> = process.env): boolean => paidVendorsAllowed(env).has(v)

// The one sentence every skipped call records (an audit row, a trace note): why nothing was asked of the vendor.
export const paidVendorOffNote = (v: PaidVendor): string => `${NAMES[v]} not called: dazl uses no paid third-party service by default (DAZL_PAID_VENDORS)`
// The status a skipped call writes where a status column exists (short, stable, greppable)
export const PAID_VENDOR_OFF = 'paid_vendor_off' as const

// The model vendor dazl may call for a tenant, from its saved keys newest first: Claude always; OpenAI only when the operator named
// 'openai'. Every place that picks "the tenant's key" uses this, so no feature quietly keeps calling OpenAI.
export function usableVendor<T extends { vendor: string }>(rowsNewestFirst: T[], env: Record<string, string | undefined> = process.env): T | undefined {
  return rowsNewestFirst.find(r => r.vendor !== 'openai' || paidVendorOn('openai', env))
}
