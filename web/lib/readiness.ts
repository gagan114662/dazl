import { scanOutcome } from './scan/scan-outcome.ts'
import { coreSources, type ServerSources } from './scan/source-availability.ts'

// Home readiness checklist and recent plays. Pure and client-safe: it only reads the existing status endpoints'
// responses (profile, usage, outreach settings, scan jobs) and never decides anything the server enforces.
// The checklist is the steps a new workspace finishes before its first useful scan and send; Home hides it once every row is done.

export interface ReadinessInput {
  profile: { sells?: string; website?: string; business_name?: string; buyer?: { summary?: string; who?: string[] } | null } | null
  usage: { has_key?: boolean; trial?: { funded?: boolean; remaining?: number } | null } | null
  outreach: { gmail?: { email?: string; status?: string } | null; sender?: { sender_name?: string; postal_address?: string; booking_url?: string | null } | null; daily_cap?: number; sent_24h?: number; account_sent_24h?: number } | null
  // The account's scan jobs; null when they could not be loaded, omitted by callers that only check the other rows.
  jobs?: JobRow[] | null
  // The server's source switches (GET /api/scan/sources); null when they could not be loaded.
  sources?: ServerSources | null
}
export type Fix = { kind: 'link'; href: string; label: string } | { kind: 'inline'; label: string }
export interface Row { id: 'site' | 'brain' | 'play' | 'key' | 'sources' | 'gmail' | 'sender' | 'limit'; label: string; state: 'done' | 'todo' | 'unknown'; detail: string; fix: Fix | null }

export function readinessRows(i: ReadinessInput): Row[] {
  const p = i.profile, u = i.usage, o = i.outreach
  const missing = p ? [!p.business_name && 'business name', !p.sells && 'what you sell', !p.website && 'website'].filter(Boolean) as string[] : []
  // Business details only (name, what it sells, website): the buyer profile is not checked here.
  const SITE = 'Website and business details'
  const site: Row = !p ? { id: 'site', label: SITE, state: 'unknown', detail: 'could not check', fix: null }
    : missing.length === 0 ? { id: 'site', label: SITE, state: 'done', detail: `${p.business_name} - ${p.sells} (${p.website!.replace(/^https:\/\//, '')})`, fix: null }
    : { id: 'site', label: SITE, state: 'todo', detail: `missing ${missing.join(', ')}`, fix: { kind: 'inline', label: 'Add' } }
  // The brain: the saved buyer profile (who buys it), which the first search is built on. It is built and edited in the
  // Home setup steps, which the fix link reopens at that step.
  const BRAIN = 'Buyer profile (who buys from you)'
  const b = p?.buyer
  const brain: Row = !p ? { id: 'brain', label: BRAIN, state: 'unknown', detail: 'could not check', fix: null }
    : b && ((b.who?.length ?? 0) > 0 || !!b.summary?.trim()) ? { id: 'brain', label: BRAIN, state: 'done', detail: b.summary?.trim() || (b.who ?? []).join(', '), fix: null }
    : { id: 'brain', label: BRAIN, state: 'todo', detail: 'not built yet: dazl drafts it from your website, you edit it', fix: { kind: 'link', href: '/app?setup=brain', label: 'Build' } }
  // Any search the account wrote itself counts, whatever it found; imports and test fixtures are not plays.
  const own = i.jobs ? i.jobs.filter(j => j.query && !j.csv_domain && !j.test_only).length : 0
  const play: Row = !i.jobs ? { id: 'play', label: 'First play', state: 'unknown', detail: 'could not check', fix: null }
    : own > 0 ? { id: 'play', label: 'First play', state: 'done', detail: `${own} search${own === 1 ? '' : 'es'} written`, fix: null }
    : { id: 'play', label: 'First play', state: 'todo', detail: 'describe who you want to find, in one sentence', fix: { kind: 'link', href: '/app/leads', label: 'Write a play' } }
  const trialLeft = u?.trial?.funded ? u.trial.remaining ?? 0 : 0
  const key: Row = !u ? { id: 'key', label: 'AI key', state: 'unknown', detail: 'could not check', fix: null }
    : u.has_key ? { id: 'key', label: 'AI key', state: 'done', detail: 'saved', fix: null }
    // Free searches cover the first scan; the row comes back as a to-do when they run out.
    : trialLeft > 0 ? { id: 'key', label: 'AI key', state: 'done', detail: `using free searches (${trialLeft} left)`, fix: null }
    : { id: 'key', label: 'AI key', state: 'todo', detail: 'needed for searches', fix: { kind: 'inline', label: 'Add key' } }
  // At least one source a scan here can use (capabilities, as Leads shows them; a scan may still skip one). Without a
  // usable AI key no scan can start, so that is a to-do whatever else is switched on. Unknown unless both checks loaded;
  // adding a key is the only fix a user can make, so it is the one link offered.
  const core = coreSources(i.sources ?? null, u ? { has_key: u.has_key, trial: u.trial } : null)
  const research = core?.find(r => r.id === 'research')
  const usableSources = core?.filter(r => r.usable) ?? []
  const sources: Row = !core ? { id: 'sources', label: 'Lead sources', state: 'unknown', detail: 'could not check', fix: null }
    : !research?.usable ? { id: 'sources', label: 'Lead sources', state: 'todo', detail: 'a scan cannot start until you add an AI key', fix: research?.fix ? { kind: 'link', href: research.fix.href, label: research.fix.label } : null }
    : { id: 'sources', label: 'Lead sources', state: 'done', detail: `a scan can use ${usableSources.map(r => r.label).join(', ')}`, fix: null }
  const gmail: Row = !o ? { id: 'gmail', label: 'Gmail', state: 'unknown', detail: 'could not check', fix: null }
    : o.gmail?.status === 'active' ? { id: 'gmail', label: 'Gmail', state: 'done', detail: `sending from ${o.gmail.email ?? 'your Gmail'}`, fix: null }
    : { id: 'gmail', label: 'Gmail', state: 'todo', detail: o.gmail ? 'needs reconnecting' : 'not connected (signing in with Google does not connect it)', fix: { kind: 'link', href: '/app/settings#gmail', label: o.gmail ? 'Reconnect' : 'Connect' } }
  const senderOk = !!o?.sender?.sender_name && !!o?.sender?.postal_address
  const sender: Row = !o ? { id: 'sender', label: 'Sender name and mailing address', state: 'unknown', detail: 'could not check', fix: null }
    : senderOk ? { id: 'sender', label: 'Sender name and mailing address', state: 'done', detail: o.sender!.sender_name!, fix: null }
    : { id: 'sender', label: 'Sender name and mailing address', state: 'todo', detail: 'added to every email; required before sending', fix: { kind: 'inline', label: 'Add' } }
  // The daily limit is the server's send cap (an operator setting, at most 20), not a per-workspace choice: this row reports it.
  const cap = o?.daily_cap, used = sentToday(o)
  const limit: Row = typeof cap !== 'number' ? { id: 'limit', label: 'Daily sending limit', state: 'unknown', detail: 'could not check', fix: null }
    : { id: 'limit', label: 'Daily sending limit', state: 'done', detail: `up to ${cap} emails a day${used !== null ? `; ${used} sent in the last 24 hours` : ''}`, fix: null }
  return [site, brain, play, key, sources, gmail, sender, limit]
}

// Sends counted against the cap: the whole account budget when reported, else first touches only (a lower bound).
function sentToday(o: ReadinessInput['outreach']): number | null {
  const n = [o?.account_sent_24h, o?.sent_24h].filter((x): x is number => typeof x === 'number')
  return n.length ? Math.max(...n) : null
}

// Shown on Home whether or not the checklist is complete: a finished setup must never hide why sending has stopped.
// The budget is a rolling 24 hours, so it frees up as earlier sends age out (not at midnight).
export function capNotice(o: ReadinessInput['outreach']): string | null {
  const cap = o?.daily_cap, used = sentToday(o)
  if (typeof cap !== 'number' || used === null || used < cap) return null
  return `Today's ${cap}-email limit is used up (${used} sent in the last 24 hours). Sending resumes as those sends pass 24 hours old.`
}

export interface JobRow { id: string; status: string; error: string | null; query: string | null; csv_domain: string | null; created_at: number; lead_count: number; funded_by?: string | null; candidates?: number | null; verified?: number | null; needs_review?: number | null; dropped?: number | null; test_only?: boolean }
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
  // The same recorded outcome as the Leads history and the campaign page (lib/scan/scan-outcome.ts), in short words.
  const o = scanOutcome(j)
  if (o.kind === 'running') return 'running'
  if (o.kind === 'enriching') return 'finishing'
  if (o.kind === 'stopped') return j.error === 'cancelled' ? 'cancelled' : 'stopped'
  if (o.kind === 'failed') {
    // A rejected key says whose it was, exactly as the history and campaign page do (funded_by from the scan record).
    if (j.error === 'trial_key_invalid' || (j.error === 'key_rejected' && j.funded_by === 'trial')) return 'failed: free-search key trouble'
    if (j.error === 'key_rejected') return j.funded_by === 'user' ? 'failed: your AI key was rejected' : 'failed: AI key rejected'
    return 'failed'
  }
  if (o.kind === 'none_extracted') return 'no candidates extracted'
  // Older records never stored the check counts: say so, and never call what they found "leads".
  if (o.kind === 'unrecorded') return 'counts unavailable'
  if (o.kind === 'all_dropped') return `${j.candidates} found, all dropped by the checks`
  const review = j.needs_review ?? 0
  return `${j.verified ?? 0} source-checked, ${review} need${review === 1 ? 's' : ''} your review`
}
