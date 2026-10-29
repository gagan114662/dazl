// Which session adapters can actually run. An adapter whose fetcher is unfinished must say so, not pretend to search: it
// returns an explicit "unsupported capability" through the worker, the audit trail and Settings, and dazl collects no
// session for it (nothing could use it, and a stored cookie is a risk with no benefit). The list is a fact about the
// session worker (session-worker/src/fetchers.ts); a test pins the two together so they cannot drift.
import type { AdvPlatform } from './config.ts'

export const UNSUPPORTED_ADAPTERS: Partial<Record<AdvPlatform, string>> = {
  facebook: 'Facebook has no cookie-only search dazl can call; the adapter would need a browser worker and is not built.',
  xiaohongshu: 'XiaoHongShu signs every web request and the signing is not implemented, so the adapter cannot fetch.',
}
export const adapterUnsupportedReason = (p: AdvPlatform): string | null => UNSUPPORTED_ADAPTERS[p] ?? null
export const adapterSupported = (p: AdvPlatform): boolean => adapterUnsupportedReason(p) === null
export const UNSUPPORTED_STATUS = 'unsupported_capability'
