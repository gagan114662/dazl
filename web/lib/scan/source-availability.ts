// Which sources a scan in this workspace can actually use, and for each one that cannot, why and where to fix it.
// Pure and client-safe: it reads the operator switches (from GET /api/scan/sources), the account's key state
// (GET /api/usage) and its social connections (GET /api/settings/advanced). It decides nothing the runner enforces; it
// only describes it, so the page never offers or names a source that would not be searched.

export interface ServerSources { web_index: boolean; news: boolean; websites: boolean }
export interface KeyState { has_key?: boolean; trial?: { funded?: boolean; remaining?: number } | null }
export interface SocialPlatform { platform: string; allowed?: boolean; supported?: boolean; consent: boolean; connected: boolean; enabled: boolean; operator_index?: boolean }
export interface Advanced { available: boolean; platforms: SocialPlatform[] }

export type Fix = { href: string; label: string }
export interface SourceRow { id: string; label: string; usable: boolean; reason?: string; fix?: Fix }

const OPERATOR = 'not set up on this server'
const SOCIAL_LABEL: Record<string, string> = { x: 'X posts', linkedin: 'LinkedIn', reddit: 'Reddit', instagram: 'Instagram', facebook: 'Facebook', xiaohongshu: 'Xiaohongshu', bilibili: 'Bilibili' }
// A platform's display name; an unknown id is capitalised rather than shown raw.
export const socialLabel = (p: string) => SOCIAL_LABEL[p] ?? (p ? p[0].toUpperCase() + p.slice(1) : p)
const SOCIAL_FIX: Fix = { href: '/app/settings#social', label: 'Set up' }

// The sources every search uses when they are available. null input = could not be checked (never shown as usable).
export function coreSources(server: ServerSources | null, key: KeyState | null): SourceRow[] | null {
  if (!server || !key) return null
  const keyed = !!key.has_key || (!!key.trial?.funded && (key.trial.remaining ?? 0) > 0)
  const op = (id: string, label: string, on: boolean): SourceRow => on ? { id, label, usable: true } : { id, label, usable: false, reason: OPERATOR }
  return [
    keyed ? { id: 'research', label: 'Web research with your AI key', usable: true }
      : { id: 'research', label: 'Web research with your AI key', usable: false, reason: key.trial?.funded ? 'free searches used up; no key' : 'no key', fix: { href: '/app/settings#model-key', label: 'Add key' } },
    op('web_index', 'Web search index', server.web_index),
    op('news', 'News articles', server.news),
    op('websites', 'Company websites', server.websites),
  ]
}

// Social sources this server offers: usable exactly when the Leads page offers the checkbox (consent, and connected +
// enabled or the operator's web index); otherwise the first missing step the user can take. A platform the server does
// not offer at all (the tier is off, or that platform is not switched on) is not listed: there is nothing to set up.
export function socialSources(adv: Advanced | null): SourceRow[] {
  if (!adv || !adv.available) return []
  return adv.platforms.filter(p => p.allowed !== false).map(p => {
    const label = socialLabel(p.platform)
    const id = `social:${p.platform}`
    // the worker cannot read it at all: nothing to set up, never searched (#436)
    if (p.supported === false) return { id, label, usable: false, reason: 'not available yet' }
    if (!p.consent) return { id, label, usable: false, reason: 'consent needed', fix: SOCIAL_FIX }
    if (p.operator_index || (p.connected && p.enabled)) return { id, label, usable: true }
    if (!p.connected) return { id, label, usable: false, reason: 'not connected', fix: SOCIAL_FIX }
    return { id, label, usable: false, reason: 'turned off', fix: SOCIAL_FIX }
  })
}

// "Web search index, News articles" - only usable rows, in order. Empty string when none.
export const usableLabels = (rows: SourceRow[]) => rows.filter(r => r.usable).map(r => r.label).join(', ')
