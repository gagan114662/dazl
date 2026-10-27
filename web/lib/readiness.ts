// Home readiness checklist and recent plays. Pure and client-safe: it only reads the existing status endpoints'
// responses (profile, usage, outreach settings, scan jobs) and never decides anything the server enforces.

export interface ReadinessInput {
  profile: { sells?: string; website?: string; business_name?: string } | null
  usage: { has_key?: boolean; trial?: { funded?: boolean; remaining?: number } | null } | null
  outreach: { gmail?: { email?: string; status?: string } | null; sender?: { sender_name?: string; postal_address?: string; booking_url?: string | null } | null } | null
}
export type Fix = { kind: 'link'; href: string; label: string } | { kind: 'inline'; label: string }
export interface Row { id: 'site' | 'key' | 'gmail' | 'sender'; label: string; state: 'done' | 'todo' | 'unknown'; detail: string; fix: Fix | null }

export function readinessRows(i: ReadinessInput): Row[] {
  const p = i.profile, u = i.usage, o = i.outreach
  const missing = p ? [!p.business_name && 'business name', !p.sells && 'what you sell', !p.website && 'website'].filter(Boolean) as string[] : []
  const site: Row = !p ? { id: 'site', label: 'Your business', state: 'unknown', detail: 'could not check', fix: null }
    : missing.length === 0 ? { id: 'site', label: 'Your business', state: 'done', detail: `${p.business_name} - ${p.sells} (${p.website!.replace(/^https:\/\//, '')})`, fix: null }
    : { id: 'site', label: 'Your business', state: 'todo', detail: `missing ${missing.join(', ')}`, fix: { kind: 'inline', label: 'Add' } }
  const trialLeft = u?.trial?.funded ? u.trial.remaining ?? 0 : 0
  const key: Row = !u ? { id: 'key', label: 'AI key', state: 'unknown', detail: 'could not check', fix: null }
    : u.has_key ? { id: 'key', label: 'AI key', state: 'done', detail: 'saved', fix: null }
    : { id: 'key', label: 'AI key', state: 'todo', detail: trialLeft > 0 ? `not added; ${trialLeft} free search${trialLeft === 1 ? '' : 'es'} left` : 'needed for searches', fix: { kind: 'inline', label: 'Add key' } }
  const gmail: Row = !o ? { id: 'gmail', label: 'Gmail', state: 'unknown', detail: 'could not check', fix: null }
    : o.gmail?.status === 'active' ? { id: 'gmail', label: 'Gmail', state: 'done', detail: `sending from ${o.gmail.email ?? 'your Gmail'}`, fix: null }
    : { id: 'gmail', label: 'Gmail', state: 'todo', detail: o.gmail ? 'needs reconnecting' : 'not connected (signing in with Google does not connect it)', fix: { kind: 'link', href: '/app/settings#gmail', label: o.gmail ? 'Reconnect' : 'Connect' } }
  const senderOk = !!o?.sender?.sender_name && !!o?.sender?.postal_address
  const sender: Row = !o ? { id: 'sender', label: 'Sender name and mailing address', state: 'unknown', detail: 'could not check', fix: null }
    : senderOk ? { id: 'sender', label: 'Sender name and mailing address', state: 'done', detail: o.sender!.sender_name!, fix: null }
    : { id: 'sender', label: 'Sender name and mailing address', state: 'todo', detail: 'added to every email; required before sending', fix: { kind: 'inline', label: 'Add' } }
  return [site, key, gmail, sender]
}

export interface JobRow { id: string; status: string; error: string | null; query: string | null; csv_domain: string | null; created_at: number; lead_count: number; verified?: number | null; needs_review?: number | null; test_only?: boolean }
export interface Play { id: string; query: string; outcome: string }

// The account's own searches, newest first, with what each produced. Imports and test fixtures are not plays.
// A finished search reports source-checked and needs-review counts separately (the same words as the Leads history):
// research-only leads are never shown as yield. Older records without those counts say "counts unavailable", never a lead total.
export function recentPlays(jobs: JobRow[], limit = 5): Play[] {
  return jobs.filter(j => j.query && !j.csv_domain && !j.test_only)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit)
    .map(j => ({ id: j.id, query: j.query!, outcome: outcomeOf(j) }))
}

function outcomeOf(j: JobRow): string {
  if (j.status === 'failed') return j.error === 'cancelled' ? 'cancelled' : 'failed'
  if (j.status !== 'done') return 'running'
  // Older records never stored the check counts: say so, and never call what they found "leads".
  if (j.verified == null && j.needs_review == null) return 'counts unavailable'
  const review = j.needs_review ?? 0
  return `${j.verified ?? 0} source-checked, ${review} need${review === 1 ? 's' : ''} your review`
}
