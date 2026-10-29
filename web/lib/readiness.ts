import { scanOutcome } from './scan/scan-outcome.ts'
import { coreSources, socialSources, type Advanced, type ServerSources } from './scan/source-availability.ts'

// Home readiness checklist and recent plays. Pure and client-safe: it only reads the existing status endpoints'
// responses (profile, usage, outreach settings, scan jobs) and never decides anything the server enforces.
// The checklist is the steps a new workspace finishes before its first useful scan and send; Home hides it once every row is done.

export interface ReadinessInput {
  profile: { sells?: string; website?: string; business_name?: string; buyer?: { summary?: string; who?: string[] } | null } | null
  usage: { has_key?: boolean; trial?: { funded?: boolean; remaining?: number } | null; scans_used?: number; scan_limit?: number } | null
  outreach: { gmail?: { email?: string; status?: string } | null; sender?: { sender_name?: string; postal_address?: string; booking_url?: string | null } | null; daily_cap?: number; sent_24h?: number; account_sent_24h?: number } | null
  // The account's scan jobs; null when they could not be loaded, omitted by callers that only check the other rows.
  jobs?: JobRow[] | null
  // Complete counts over ALL of the account's own searches (GET /api/scan/jobs `totals`; the jobs list is the newest
  // 20 only). null/omitted when not reported: absence is then claimed only from a list that was not full.
  totals?: { searches: number; finished: number } | null
  // The server's source switches (GET /api/scan/sources); null when they could not be loaded.
  sources?: ServerSources | null
  // The saved AI keys' status (GET /api/settings/llm-key: vendor, last 4, when the provider accepted it); null when not loaded.
  keys?: { vendor: string; last4: string; validated_at: number }[] | null
  // From the same read: a scan that stopped on a key error with no acceptance of every saved key since (server-side,
  // lib/llm/key-evidence.ts). The record never says which key a scan used, so neither does this. null when none or not loaded.
  rejection?: { error: 'key_rejected' | 'key_unreadable' } | null
  // The account's social sources (GET /api/settings/advanced); null when not loaded.
  advanced?: Advanced | null
  // This account's emails (GET /api/outreach: the newest 200 only) and its recent campaigns (GET /api/campaigns: the
  // last 10 searches, with complete per-scan rejected and email counts). null when they could not be loaded; omitted by
  // callers that only check other rows.
  messages?: { status: string; lead_id?: string; test?: number | boolean | null }[] | null
  campaigns?: { id: string; status?: string; qualification: { rejected: number; sourceChecked?: number; confirmedByYou?: number; needsReview?: number; held?: number }; contact?: { withContact: number; readyWithContact?: number; draftable?: number }; outreach?: { drafts: number; approved: number; sent: number } }[] | null
}
export type Fix = { kind: 'link'; href: string; label: string } | { kind: 'inline'; label: string }
export interface Row { id: 'site' | 'brain' | 'play' | 'key' | 'sources' | 'scan' | 'review' | 'gmail' | 'sender' | 'approved' | 'limit'; label: string; state: 'done' | 'todo' | 'unknown'; detail: string; fix: Fix | null; next?: boolean }

// The reads' caps (lib/outreach/service.ts listMessages, lib/outreach/campaigns.ts listCampaigns): a list this long may
// be missing older history.
// The jobs list (lib/scan/store-db.ts listJobs) is the newest 20.
const MESSAGES_CAP = 200, CAMPAIGNS_CAP = 10, JOBS_CAP = 20

export function readinessRows(i: ReadinessInput): Row[] {
  const p = i.profile, u = i.usage, o = i.outreach
  const missing = p ? [!p.business_name && 'business name', !p.sells && 'what you sell', !p.website && 'website'].filter(Boolean) as string[] : []
  // Business details only (name, what it sells, website): the buyer profile is not checked here.
  const SITE = 'Website and business details'
  const site: Row = !p ? { id: 'site', label: SITE, state: 'unknown', detail: 'could not check - your profile did not load', fix: null }
    : missing.length === 0 ? { id: 'site', label: SITE, state: 'done', detail: `${p.business_name} - ${p.sells} (${p.website!.replace(/^https:\/\//, '')})`, fix: null }
    : { id: 'site', label: SITE, state: 'todo', detail: `missing ${missing.join(', ')}`, fix: { kind: 'inline', label: 'Add' } }
  // The brain: the saved buyer profile (who buys it), which the first search is built on. It is built and edited in the
  // Home setup steps, which the fix link reopens at that step.
  const BRAIN = 'Buyer profile (who buys from you)'
  const b = p?.buyer
  const brain: Row = !p ? { id: 'brain', label: BRAIN, state: 'unknown', detail: 'could not check - your profile did not load', fix: null }
    : b && ((b.who?.length ?? 0) > 0 || !!b.summary?.trim()) ? { id: 'brain', label: BRAIN, state: 'done', detail: b.summary?.trim() || (b.who ?? []).join(', '), fix: null }
    : { id: 'brain', label: BRAIN, state: 'todo', detail: 'not built yet: dazl drafts it from your website, you edit it', fix: { kind: 'link', href: '/app?setup=brain', label: 'Build' } }
  // Any search the account wrote itself counts, whatever it found; imports and test fixtures are not plays.
  // Instinct #288: the jobs list is the newest 20. Its contents prove a play or a finished scan exists; its silence
  // proves nothing when it is full, so absence comes from the complete totals, or is "?" when they are missing.
  const listFull = (i.jobs?.length ?? 0) >= JOBS_CAP
  const own = i.totals ? i.totals.searches : i.jobs ? i.jobs.filter(j => j.query && !j.csv_domain && !j.test_only).length : 0
  const play: Row = !i.jobs && !i.totals ? { id: 'play', label: 'First play', state: 'unknown', detail: 'could not check - your searches did not load', fix: null }
    : own > 0 ? { id: 'play', label: 'First play', state: 'done', detail: `${own} search${own === 1 ? '' : 'es'} written`, fix: null }
    : !i.totals && listFull ? { id: 'play', label: 'First play', state: 'unknown', detail: `could not check - only your latest ${JOBS_CAP} scans could be checked`, fix: null }
    : { id: 'play', label: 'First play', state: 'todo', detail: 'describe who you want to find, in one sentence', fix: { kind: 'link', href: '/app/leads', label: 'Write a play' } }
  const trialLeft = u?.trial?.funded ? u.trial.remaining ?? 0 : 0
  // A saved key was accepted by its provider when it was saved. After that, the server reports a rejection while any
  // saved key has not been accepted again since that scan; it cannot say which key the scan used, so neither does Home.
  // A later cancelled, failed or done scan never clears it. Without the key status loaded, no claim either way.
  const rej = u?.has_key ? i.rejection ?? null : null
  const keyError = rej?.error ?? null
  const last4 = i.keys?.length === 1 ? ` (ending ${i.keys[0].last4})` : ''
  const again = (i.keys?.length ?? 0) > 1 ? 'save each of your keys again to confirm they work' : 'save your key again to confirm it works'
  const rejDetail = !rej ? '' : rej.error === 'key_rejected'
    ? `a scan stopped because the AI provider rejected its key, after your key${(i.keys?.length ?? 0) > 1 ? 's were' : ' was'} last saved - ${again}`
    : `a scan could not read its AI key after your key${(i.keys?.length ?? 0) > 1 ? 's were' : ' was'} last saved - ${again}`
  const key: Row = !u ? { id: 'key', label: 'AI key', state: 'unknown', detail: 'could not check - your plan and key status did not load', fix: null }
    : keyError ? { id: 'key', label: 'AI key', state: 'todo', detail: rejDetail, fix: { kind: 'inline', label: 'Replace key' } }
    : u.has_key ? { id: 'key', label: 'AI key', state: 'done', detail: i.keys?.length ? `saved${last4}; your provider accepted it when it was saved` : 'saved', fix: null }
    // Free searches cover the first scan; the row comes back as a to-do when they run out.
    : trialLeft > 0 ? { id: 'key', label: 'AI key', state: 'done', detail: `using free searches (${trialLeft} left)`, fix: null }
    : { id: 'key', label: 'AI key', state: 'todo', detail: 'needed for searches', fix: { kind: 'inline', label: 'Add key' } }
  // At least one source a scan here can use (capabilities, as Leads shows them; a scan may still skip one). Without a
  // usable AI key no scan can start, so that is a to-do whatever else is switched on. Unknown unless both checks loaded;
  // adding a key is the only fix a user can make, so it is the one link offered.
  const core = coreSources(i.sources ?? null, u ? { has_key: u.has_key, trial: u.trial } : null)
  const research = core?.find(r => r.id === 'research')
  // Only usable sources are named as usable; every other source is listed as not available, with its reason. Social
  // sources are added only when they loaded (a failed read never lists them either way).
  const all = core ? [...core, ...socialSources(i.advanced ?? null)] : []
  const usableSources = all.filter(r => r.usable)
  const off = all.filter(r => !r.usable && r.id !== 'research')
  const offText = off.length ? `. Not available: ${off.map(r => `${r.label} (${r.reason})`).join(', ')}` : ''
  const offFix = off.find(r => r.fix)?.fix
  const sources: Row = !core ? { id: 'sources', label: 'Lead sources', state: 'unknown', detail: 'could not check - the source settings did not load', fix: null }
    // The key row's evidence that the saved key stopped working means web research cannot run either.
    : keyError ? { id: 'sources', label: 'Lead sources', state: 'todo', detail: `a scan may not run until you save your AI key again${offText}`, fix: { kind: 'link', href: '/app/settings#model-key', label: 'Replace key' } }
    : !research?.usable ? { id: 'sources', label: 'Lead sources', state: 'todo', detail: `a scan cannot start until you add an AI key${offText}`, fix: research?.fix ? { kind: 'link', href: research.fix.href, label: research.fix.label } : null }
    : { id: 'sources', label: 'Lead sources', state: 'done', detail: `a scan can use ${usableSources.map(r => r.label).join(', ')}${offText}`, fix: offFix ? { kind: 'link', href: offFix.href, label: offFix.label } : null }
  const gmail: Row = !o ? { id: 'gmail', label: 'Gmail', state: 'unknown', detail: 'could not check - your sending settings did not load', fix: null }
    : o.gmail?.status === 'active' ? { id: 'gmail', label: 'Gmail', state: 'done', detail: `sending from ${o.gmail.email ?? 'your Gmail'}`, fix: null }
    : { id: 'gmail', label: 'Gmail', state: 'todo', detail: o.gmail ? 'needs reconnecting' : 'not connected (signing in with Google does not connect it)', fix: { kind: 'link', href: '/app/settings#gmail', label: o.gmail ? 'Reconnect' : 'Connect' } }
  const senderOk = !!o?.sender?.sender_name && !!o?.sender?.postal_address
  const sender: Row = !o ? { id: 'sender', label: 'Sender name and mailing address', state: 'unknown', detail: 'could not check - your sending settings did not load', fix: null }
    : senderOk ? { id: 'sender', label: 'Sender name and mailing address', state: 'done', detail: o.sender!.sender_name!, fix: null }
    : { id: 'sender', label: 'Sender name and mailing address', state: 'todo', detail: 'added to every email; required before sending', fix: { kind: 'inline', label: 'Add' } }
  // The daily limit is the server's send cap (an operator setting, at most 20), not a per-workspace choice: this row reports it.
  const cap = o?.daily_cap, used = sentToday(o)
  const limit: Row = typeof cap !== 'number' ? { id: 'limit', label: 'Daily sending limit', state: 'unknown', detail: 'could not check - your sending settings did not load', fix: null }
    : { id: 'limit', label: 'Daily sending limit', state: 'done', detail: `up to ${cap} emails a day${used !== null ? `; ${used} sent in the last 24 hours` : ''}`, fix: null }
  // The Pancake path after setup: a finished scan, leads looked at, an email approved. Each counts only on positive
  // evidence; a read that failed is "could not check", never a check.
  const ownJobs = i.jobs?.filter(j => j.query && !j.csv_domain && !j.test_only) ?? []
  const finished = ownJobs.filter(j => j.status === 'done').sort((a, b) => b.created_at - a.created_at)
  const runningNow = ownJobs.some(j => ['pending', 'running', 'enriching'].includes(j.status))
  const finishedCount = i.totals ? i.totals.finished : finished.length
  const scan: Row = !i.jobs && !i.totals ? { id: 'scan', label: 'First scan', state: 'unknown', detail: 'could not check - your searches did not load', fix: null }
    : finishedCount > 0 || finished.length > 0 ? { id: 'scan', label: 'First scan', state: 'done', detail: `${Math.max(finishedCount, finished.length)} finished${finished.length ? `; latest: ${recentPlays(finished, 1)[0]?.outcome ?? 'finished'}` : ''}`, fix: null }
    : !i.totals && listFull && !runningNow ? { id: 'scan', label: 'First scan', state: 'unknown', detail: `could not check - only your latest ${JOBS_CAP} scans could be checked`, fix: null }
    : runningNow ? { id: 'scan', label: 'First scan', state: 'todo', detail: 'running now', fix: { kind: 'link', href: '/app/leads', label: 'See progress' } }
    : { id: 'scan', label: 'First scan', state: 'todo', detail: 'no scan has finished yet', fix: { kind: 'link', href: '/app/leads', label: 'Find leads' } }
  // Reviewed = a lead approved (an email made from it) or rejected. Both reads are capped (the newest 200 emails, the
  // last 10 campaigns), so finding one proves it, but finding none proves nothing unless the read was complete: then
  // the row is "?", never a to-do built on missing history.
  // Completeness is judged on the read as returned (it is capped); test sends are then left out of every count.
  const msgsComplete = !!i.messages && i.messages.length < MESSAGES_CAP
  const msgs = i.messages ? i.messages.filter(m => !m.test) : null, camps = i.campaigns ?? null
  const campsComplete = !!camps && camps.length < CAMPAIGNS_CAP
  const made = msgs ? msgs.filter(m => m.status !== 'skipped').length : 0
  const campMade = camps ? camps.reduce((n, c) => n + (c.outreach ? c.outreach.drafts + c.outreach.approved + c.outreach.sent : 0), 0) : 0
  const rejected = camps ? camps.reduce((n, c) => n + (c.qualification?.rejected ?? 0), 0) : 0
  const latest = finished[0]
  const reviewFix: Fix = { kind: 'link', href: latest ? `/app/leads?job_id=${latest.id}` : '/app/leads', label: 'Review leads' }
  const unread = (what: string[]) => `could not check - ${what.join(' and ')}`
  const reviewGap = [!msgs ? 'your emails did not load' : !msgsComplete ? `only your latest ${MESSAGES_CAP} emails could be checked` : '', !camps ? 'your campaigns did not load' : !campsComplete ? `only your latest ${CAMPAIGNS_CAP} searches could be checked` : ''].filter(Boolean)
  const review: Row = made + campMade + rejected > 0 ? { id: 'review', label: 'Leads reviewed', state: 'done', detail: rejected > 0 ? `leads approved into drafts or rejected (${rejected} rejected)` : 'leads approved into drafts', fix: null }
    : reviewGap.length ? { id: 'review', label: 'Leads reviewed', state: 'unknown', detail: unread(reviewGap), fix: null }
    : { id: 'review', label: 'Leads reviewed', state: 'todo', detail: 'approve or reject the leads of a finished scan', fix: reviewFix }
  const approvedFound = (msgs ? msgs.filter(m => m.status === 'approved' || m.status === 'sent').length : 0) + (camps ? camps.reduce((n, c) => n + (c.outreach ? c.outreach.approved + c.outreach.sent : 0), 0) : 0)
  const approved: Row = approvedFound > 0 ? { id: 'approved', label: 'First email approved in Outreach', state: 'done', detail: 'an email approved or sent', fix: null }
    : !msgs ? { id: 'approved', label: 'First email approved in Outreach', state: 'unknown', detail: unread(['your emails did not load']), fix: null }
    : !msgsComplete ? { id: 'approved', label: 'First email approved in Outreach', state: 'unknown', detail: unread([`only your latest ${MESSAGES_CAP} emails could be checked`]), fix: null }
    : { id: 'approved', label: 'First email approved in Outreach', state: 'todo', detail: made ? 'a draft is waiting for your review' : 'approve a lead first, then review its draft', fix: { kind: 'link', href: '/app/outreach', label: 'Open Outreach' } }
  const rows = [site, brain, key, sources, play, scan, review, gmail, sender, approved, limit]
  // The next step: the first row that is still to do. A row that could not be checked is not skipped over silently,
  // but it is not "next" either (there is nothing to press).
  const nextRow = rows.find(r => r.state === 'todo')
  if (nextRow) nextRow.next = true
  return rows
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
    if (j.error === 'key_rejected') return 'failed: AI key rejected'
    return 'failed'
  }
  if (o.kind === 'none_extracted') return 'no candidates extracted'
  // Older records never stored the check counts: say so, and never call what they found "leads".
  if (o.kind === 'unrecorded') return 'counts unavailable'
  if (o.kind === 'all_dropped') return `${j.candidates} found, all dropped by the checks`
  const review = j.needs_review ?? 0
  return `${j.verified ?? 0} source-checked, ${review} need${review === 1 ? 's' : ''} your review`
}
