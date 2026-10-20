const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function s(v: unknown, max: number): string | null {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : null
}

// Returns the cleaned leads, or an error string. Worker input is untrusted
// too: it comes from an LLM that read web pages.
export function parseLeads(raw: unknown) {
  if (!Array.isArray(raw) || raw.length === 0) return 'leads must be a non-empty array'
  if (raw.length > 50) return 'at most 50 leads per request'
  const out = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') return 'each lead must be an object'
    const o = r as Record<string, unknown>
    const signal = s(o.signal, 500)
    const company = s(o.company ?? '', 150) ?? ''
    const name = s(o.name ?? '', 150) ?? ''
    if (!signal) return 'each lead needs a signal'
    if (!company && !name) return 'each lead needs a name or company'
    let source_url: string
    try {
      const u = new URL(String(o.source_url))
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('proto')
      source_url = u.toString().slice(0, 500)
    } catch {
      return 'each lead needs an http(s) source_url'
    }
    const contact = o.contact == null ? null : s(o.contact, 254)
    const email = contact && EMAIL_RE.test(contact) ? contact.toLowerCase() : contact
    const score = typeof o.score === 'number' && Number.isFinite(o.score) ? Math.max(0, Math.min(100, Math.round(o.score))) : 50
    out.push({ name, company, contact: email || null, signal, source_url, score })
  }
  return out
}
