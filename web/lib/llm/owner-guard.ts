// The owner's workspace spend pool (lib/llm/spend-pool.ts, #363) on every paid model call outside the scan runner:
// reply intent and reply drafts, draft polish, follow-up and sequence text, SEO briefs and newsjacks, and the profile
// read from the seller's website. The runner reserves against the same pool; here each completion reserves its worst
// case (prompt bytes plus a margin in, max_tokens out, at the model's listed price) before the call, in the shared store,
// so a restart, a retry, a second instance or another kind of paid call cannot reset or pass the limit.
// Only when the operator set a limit for this owner (DAZL_RUN_MAX_USD_USERS / DAZL_OWNER_MONTH_MAX_USD_USERS); without
// one the provider is returned unchanged. With one, a model without a listed price is refused (fails closed), and so is
// a reservation the store could not save. A refused call is never made: the caller's own fallback (a template, an
// error) applies, and nothing is billed.
// Reservations here stay at the worst case: a plain completion reports no usage, so no billed figure is recorded
// (reported_usd stays as the vendor reported it: untouched).
import type { DbLike } from '../db/client.ts'
import type { Provider } from './provider.ts'
import { guardProvider, PooledGuard, SpendRefused } from './spend-guard.ts'
import { ownerLimits, sharedPool } from './spend-pool.ts'

export function ownerGuarded(d: DbLike, ownerId: string, p: Provider, env: Record<string, string | undefined> = process.env): Provider {
  const limits = ownerLimits(ownerId, env)
  return limits ? guardProvider(p, new PooledGuard(sharedPool(d, ownerId, limits))) : p
}
export const spendRefused = (e: unknown): e is SpendRefused => e instanceof SpendRefused
