// Advanced connectors: opt-in, session-credential backends that run in a separate worker.
// Everything here is off unless the operator turns it on. The kill switch is read on every call.
export const ADV_PLATFORMS = ['x', 'reddit', 'xiaohongshu', 'bilibili', 'linkedin'] as const
export const UI_PLATFORMS = ['linkedin', 'x', 'reddit', 'xiaohongshu', 'bilibili'] as const
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
export const scopeFor = (p: AdvPlatform): ConsentScope => (p === 'linkedin' ? 'linkedin' : 'advanced')
export const connectorId = (p: AdvPlatform) => `adv:${p}`

// Calls per user per hour, across a platform. LinkedIn is much lower.
export const maxCallsPerHour = (p: AdvPlatform, env: Record<string, string | undefined> = process.env) => (p === 'linkedin' ? 3 : Math.max(1, Number(env.ADVANCED_MAX_PER_HOUR) || 10))
