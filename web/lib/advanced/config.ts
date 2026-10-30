// Advanced connectors: opt-in, session-credential backends that run in a separate worker.
// Everything here is off unless the operator turns it on. The kill switch is read on every call.
// TODO(decision 2026-10-21, deferred): LinkedIn comment auto-replies ("reply to every
// commenter with the lead magnet") are NOT to be built as automation - automated posting on
// LinkedIn violates its terms, risks the account, and conflicts with the throwaway-account
// rule. The read-side version (surface commenters, draft replies the user posts by hand)
// needs the user's explicit go-ahead first.
export const ADV_PLATFORMS = ['x', 'reddit', 'instagram', 'facebook', 'xiaohongshu', 'bilibili', 'linkedin'] as const
export const UI_PLATFORMS = ['linkedin', 'x', 'reddit', 'instagram', 'facebook', 'xiaohongshu', 'bilibili'] as const
export type AdvPlatform = (typeof ADV_PLATFORMS)[number]
export const isAdvPlatform = (v: unknown): v is AdvPlatform => typeof v === 'string' && (ADV_PLATFORMS as readonly string[]).includes(v)
export const CONSENT_VERSION = '2026-10-20'
export type ConsentScope = 'advanced' | 'linkedin'

export interface AdvFlags { enabled: boolean; linkedin: boolean }

export function advFlags(env: Record<string, string | undefined> = process.env): AdvFlags {
  const enabled = env.ADVANCED_CONNECTORS === '1' && env.ADVANCED_KILL !== '1' && !!env.ADVANCED_WORKER_URL && !!env.ADVANCED_WORKER_TOKEN
  return { enabled, linkedin: enabled && env.ADVANCED_LINKEDIN === '1' }
}
export const platformAllowed = (p: AdvPlatform, f: AdvFlags) => (p === 'linkedin' ? f.linkedin : f.enabled)

// Platforms the session worker cannot fetch at all (session-worker/src/fetchers.ts UNSUPPORTED, the same list; a test
// holds them equal). For these dazl offers no consent and stores, sends or uses no session; a scan that names one
// records 'unsupported', never an empty search (#436).
export const UNSUPPORTED: Partial<Record<AdvPlatform, string>> = {
  facebook: 'Not built yet: Facebook has no search a session cookie alone can use, so it needs a browser worker, which dazl does not have.',
  xiaohongshu: 'Not built yet: XiaoHongShu signs every web request, and dazl does not implement that signing.',
}
export const isSupported = (p: AdvPlatform) => !UNSUPPORTED[p]
export const scopeFor = (p: AdvPlatform): ConsentScope => (p === 'linkedin' ? 'linkedin' : 'advanced')
export const connectorId = (p: AdvPlatform) => `adv:${p}`

// Calls per user per hour, across a platform. LinkedIn is much lower.
export const maxCallsPerHour = (p: AdvPlatform, env: Record<string, string | undefined> = process.env) => (p === 'linkedin' ? 3 : Math.max(1, Number(env.ADVANCED_MAX_PER_HOUR) || 10))
