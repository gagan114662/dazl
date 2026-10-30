// The owner's workspace spend pool (lib/llm/spend-pool.ts, #363) on every paid model call outside the scan runner:
// reply intent and reply drafts, draft polish, follow-up and sequence text, SEO briefs and newsjacks, and the profile
// read from the seller's website. The runner reserves against the same pool; here each completion reserves its worst
// case (prompt bytes plus a margin in, max_tokens out, at the model's listed price) before the call, in the shared store,
// so a restart, a retry, a second instance or another kind of paid call cannot reset or pass the limit.
// Only when the operator set a limit for this owner (DAZL_RUN_MAX_USD_USERS / DAZL_OWNER_MONTH_MAX_USD_USERS); without
// one the provider is returned unchanged. With one, a model without a listed price is refused (fails closed), and so is
// a reservation the store could not save. A refused call is never made: the caller's own fallback (a template, an
// error) applies, and nothing is billed.
// After the call each completion is settled to what the vendor reported (guardProvider's settle, lib/llm/spend-guard.ts):
// the served model's price with cache writes and reads, so an overrun past the limit is recorded and refuses every later
// call; no usage keeps the worst-case reservation; an unknown cost (unpriced served model, invalid counts) counts the rest
// of the day (or, with only a month limit, the month) as spent. When that accounting cannot be saved, SpendAccountingFailed is thrown: the call happened, so a
// caller must not treat it as a refusal (spendRefused is false for it), and every later reservation of the owner, from any
// caller or instance, is refused until an operator clears the pending marker.
import type { DbLike } from '../db/client.ts'
import type { Provider } from './provider.ts'
import { guardProvider, PooledGuard, SpendAccountingFailed, SpendRefused } from './spend-guard.ts'
import { ownerLimits, sharedPool } from './spend-pool.ts'

export function ownerGuarded(d: DbLike, ownerId: string, p: Provider, env: Record<string, string | undefined> = process.env): Provider {
  const limits = ownerLimits(ownerId, env)
  return limits ? guardProvider(p, new PooledGuard(sharedPool(d, ownerId, limits), { trackPending: true }), undefined, undefined, true) : p
}
export const spendRefused = (e: unknown): e is SpendRefused => e instanceof SpendRefused
export const spendAccountingFailed = (e: unknown): e is SpendAccountingFailed => e instanceof SpendAccountingFailed
