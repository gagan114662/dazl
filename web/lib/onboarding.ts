// First-run helpers for the Home onboarding flow. Client-safe: no server imports, no network, no model call.

export interface Brain { summary: string; who: string[]; industries: string[]; where: string[]; signals: string[] }

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
const lower1 = (s: string) => s && /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s

// Three one-sentence requests built only from the profile the user has just reviewed. They are suggestions to edit,
// not claims about who is buying: each names a buyer, an optional place, and one public signal from the profile.
export function suggestPlays(b: Brain): string[] {
  const who = b.who.map(clean).filter(Boolean)
  const ind = b.industries.map(clean).filter(Boolean)
  const where = clean(b.where[0])
  const signals = b.signals.map(clean).filter(Boolean)
  const buyer = (i: number) => who[i % Math.max(who.length, 1)] || (ind[i % Math.max(ind.length, 1)] ? `${ind[i % ind.length]} companies` : clean(b.summary) || 'companies that fit my profile')
  const place = where ? ` in ${where}` : ''
  const fallbacks = ['hiring for a role my product supports', 'recent funding or expansion', 'a new location or launch']
  const out: string[] = []
  for (let i = 0; out.length < 3 && i < 6; i++) {
    const sig = signals[i] ? lower1(signals[i]) : fallbacks[(i - signals.length + fallbacks.length) % fallbacks.length]
    const play = `${buyer(i)}${place} - ${sig}`.slice(0, 300)
    if (!out.includes(play)) out.push(play)
  }
  return out
}

// The key's prefix decides the provider, so the user pastes one field instead of picking from a menu first.
export function vendorForKey(key: string): 'anthropic' | 'openai' | null {
  const k = key.trim()
  if (/^sk-ant-/.test(k)) return 'anthropic'
  if (/^sk-/.test(k)) return 'openai'
  return null
}

export function normalizeWebsite(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  return /^https?:\/\//i.test(s) ? s.replace(/^http:\/\//i, 'https://') : `https://${s}`
}
