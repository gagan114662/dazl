// PII redaction for traces of real runs, applied BEFORE a trace is frozen into a World (worldFromTrace refuses an
// unredacted real trace). Replacement is consistent across the whole trace - the same email becomes the same token in
// the page text, the model's reply and the lead - so a quote or contact that matched the page before still matches
// after, and the replay reaches the same verdicts on the same structure.
//
// Redacted: email local parts (the domain is kept because contact-domain checks need it; a domain can still identify a
// small company), phone digits (separators kept, so phone-shaped values stay phone-shaped), LinkedIn /in/ slugs, and every
// person name the run itself extracted (a "name" field in a model reply or a lead). KNOWN LIMIT: a person named only in
// page text, never extracted as a lead or contact name, is not found by this pass, and domains are kept. `redacted: true`
// means this pass ran: it is not permission to publish and not proof of anonymisation. Recorded Worlds are private,
// tenant-scoped and unpublished (docs/design/agent-evals.md, "Redaction").
import { createHmac, randomBytes } from 'node:crypto'
import type { Trace } from './trace.ts'

const EMAIL = /([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})/gi
const PHONE = /\+?\d[\d\s().-]{6,}\d/g
const LINKEDIN = /(linkedin\.com\/in\/)([A-Za-z0-9_%-]+)/gi

function collectNames(v: unknown, out: Set<string>): void {
  if (typeof v === 'string') {
    if (v.trim().startsWith('[') || v.trim().startsWith('{')) { try { collectNames(JSON.parse(v), out) } catch { /* not JSON */ } }
    return
  }
  if (Array.isArray(v)) { for (const x of v) collectNames(x, out); return }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    if (k === 'name' && typeof x === 'string' && x.trim().length >= 3) out.add(x.trim())
    else collectNames(x, out)
  }
}

export function redactTrace(t: Trace, salt: Buffer = randomBytes(16)): Trace {
  const h = (s: string) => createHmac('sha256', salt).update(s).digest('hex')
  const names = new Set<string>()
  for (const s of t.spans) if (s.kind === 'model') collectNames(s.output, names)
  for (const l of t.output?.leads ?? []) if (l.name.trim().length >= 3) names.add(l.name.trim())
  const nameList = [...names].sort((a, b) => b.length - a.length) // longest first: "Ada Lovelace" before "Ada"
  const str = (s: string): string => {
    // The token has no punctuation: the verifier normalises it away, and the redacted contact must still be "on the page".
    let r = s.replace(EMAIL, (_m, local: string, domain: string) => `p${h(local.toLowerCase()).slice(0, 10)}@${domain.toLowerCase()}`)
    // A phone has 9+ digits; ISO dates (8 digits, or a date then a time) are never touched, so event dates survive.
    r = r.replace(PHONE, m => { if (/^\d{4}-\d{2}-\d{2}/.test(m) || m.replace(/\D/g, '').length < 9) return m; const d = h(m.replace(/\D/g, '')); let i = 0; return m.replace(/\d/g, () => String(parseInt(d[i++ % d.length], 16) % 10)) })
    r = r.replace(LINKEDIN, (_m, pre: string, slug: string) => `${pre}redacted-${h(slug.toLowerCase()).slice(0, 10)}`)
    for (const n of nameList) r = r.split(n).join(`Person-${h(n).slice(0, 6)}`)
    return r
  }
  // Object keys too: a World keys pages and HTTP answers by URL, and a URL can carry an email or a profile slug.
  const deep = (v: unknown): unknown => typeof v === 'string' ? str(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [str(k), deep(x)])) : v
  return { ...t, redacted: true, input: deep(t.input) as Trace['input'], spans: t.spans.map(s => ({ ...s, input: deep(s.input) as Record<string, unknown>, output: deep(s.output) })), ...(t.output ? { output: deep(t.output) as Trace['output'] } : {}) }
}
