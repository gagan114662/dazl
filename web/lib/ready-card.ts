import { readinessRows, type ReadinessInput, type Row } from './readiness.ts'
import { coreSources, socialSources } from './scan/source-availability.ts'

// Home's setup checklist toward the first useful result: business profile -> search can run -> first search ->
// qualified lead -> contact -> draft -> sender setup. Read from the same tenant responses and rows as the full setup
// checklist (lib/readiness.ts), so the two never disagree. Pure and client-safe. A step is done only on positive
// evidence; a read that failed, or a capped read that found nothing, is "could not check" with no button. Each step
// that is still to do has one button straight to its fix. Sources are named only when a scan here can use them.

export type ReadyId = 'profile' | 'search' | 'play' | 'qualified' | 'contact' | 'draft' | 'sender'
export interface ReadyItem { id: ReadyId; label: string; state: Row['state']; detail: string; fix: { href: string; label: string } | null; next?: boolean }

const KEY_FIX = '/app/settings#model-key', GMAIL_FIX = '/app/settings#gmail'
// The reads' caps (lib/readiness.ts): a list this long may be missing older history.
const CAMPAIGNS_CAP = 10, MESSAGES_CAP = 200, JOBS_CAP = 20

export function readyItems(i: ReadinessInput): ReadyItem[] {
  const rows = readinessRows(i)
  const row = (id: Row['id']) => rows.find(r => r.id === id)!
  const site = row('site'), brainRow = row('brain'), key = row('key'), gmail = row('gmail'), sender = row('sender'), src = row('sources')
  const unknown = (id: ReadyId, label: string, detail: string): ReadyItem => ({ id, label, state: 'unknown', detail, fix: null })

  // 1. Business profile: what the business sells and the buyer profile, built from its website or entered by hand (#420:
  // a saved manual profile is complete without a website). The website is shown when there is one; it is not required.
  const p = i.profile
  const sells = !!p?.sells?.trim()
  const profile: ReadyItem = site.state === 'unknown' || brainRow.state === 'unknown' ? unknown('profile', 'Business profile', site.detail)
    : brainRow.state === 'done' && sells ? { id: 'profile', label: 'Business profile', state: 'done', detail: p?.website ? `${host(p.website)} - ${brainRow.detail}` : brainRow.detail, fix: null }
    : brainRow.state === 'done' ? { id: 'profile', label: 'Business profile', state: 'todo', detail: 'add what you sell', fix: { href: '/app?setup=site', label: 'Add what you sell' } }
    : !p?.website ? { id: 'profile', label: 'Business profile', state: 'todo', detail: 'add your website so dazl can read who buys from you, or describe them yourself', fix: { href: '/app?setup=site', label: 'Add website' } }
    : { id: 'profile', label: 'Business profile', state: 'todo', detail: `${host(p.website)} saved; who buys from you is not built yet`, fix: { href: '/app?setup=brain', label: 'Build profile' } }

  // 2. A search can run: a working AI key (or free searches) and the sources a scan here can use. Only usable ones named.
  const core = coreSources(i.sources ?? null, i.usage ? { has_key: i.usage.has_key, trial: i.usage.trial } : null)
  const usable = core ? [...core, ...socialSources(i.advanced ?? null)].filter(r => r.usable).map(r => r.label) : []
  // The account's scan allowance is checked first: adding a key does not get past a used-up allowance.
  const used = i.usage?.scans_used, limit = i.usage?.scan_limit
  const quotaUsed = typeof used === 'number' && typeof limit === 'number' && used >= limit
  const search: ReadyItem = quotaUsed ? { id: 'search', label: 'Search can run', state: 'todo', detail: `this month's scan allowance is used up (${used} of ${limit})`, fix: { href: '/app/settings#plan', label: 'See your plan' } }
    : key.state === 'unknown' || src.state === 'unknown' ? unknown('search', 'Search can run', key.state === 'unknown' ? key.detail : src.detail)
    : key.state === 'todo' || src.state === 'todo' ? { id: 'search', label: 'Search can run', state: 'todo', detail: key.state === 'todo' ? key.detail : 'no source can run until your AI key works', fix: { href: KEY_FIX, label: key.fix?.label ?? 'Add key' } }
    : { id: 'search', label: 'Search can run', state: 'done', detail: `${key.detail}. Sources: ${usable.join(', ')}`, fix: null }

  // 3. First search: a finished search of the account's own.
  const own = i.jobs?.filter(j => j.query && !j.csv_domain && !j.test_only) ?? []
  const finished = own.filter(j => j.status === 'done').sort((a, b) => b.created_at - a.created_at)
  const running = own.find(j => ['pending', 'running', 'enriching'].includes(j.status))
  const finishedN = Math.max(i.totals?.finished ?? 0, finished.length)
  const play: ReadyItem = !i.jobs && !i.totals ? unknown('play', 'First search', 'could not check - your searches did not load')
    : finishedN > 0 ? { id: 'play', label: 'First search', state: 'done', detail: `${finishedN} finished`, fix: null }
    : running ? { id: 'play', label: 'First search', state: 'todo', detail: 'running now', fix: { href: `/app/leads?job_id=${running.id}`, label: 'Watch it live' } }
    : !i.totals && (i.jobs?.length ?? 0) >= JOBS_CAP ? unknown('play', 'First search', `could not check - only your latest ${JOBS_CAP} scans could be checked`)
    : { id: 'play', label: 'First search', state: 'todo', detail: 'describe who you want to find, or pick a suggested play', fix: { href: '/app/leads', label: 'Run a search' } }

  // 4-6 from the campaigns read (the last 10 searches, newest first, with complete per-search counts) and the emails read.
  // Qualified = source-checked or confirmed by you and not held for timing; a contact counts only on such a lead. Each
  // fix opens the newest search in that read that holds what the step needs, so the link always goes to the right one.
  type Camp = NonNullable<ReadinessInput['campaigns']>[number]
  // The emails read is capped (newest 200): its completeness is judged as returned; test sends never count.
  const camps = i.campaigns ?? null, msgsRaw = i.messages ?? null
  const msgsComplete = !!msgsRaw && msgsRaw.length < MESSAGES_CAP
  const msgs = msgsRaw ? msgsRaw.filter(m => !m.test) : null
  const campsComplete = !!camps && camps.length < CAMPAIGNS_CAP
  const ready = (c: Camp) => Math.max(0, (c.qualification.sourceChecked ?? 0) + (c.qualification.confirmedByYou ?? 0) - (c.qualification.held ?? 0))
  const sum = (f: (c: Camp) => number) => camps ? camps.reduce((n, c) => n + f(c), 0) : 0
  const first = (f: (c: Camp) => boolean) => camps?.find(f) ?? null
  const href = (c: Camp | null) => c ? `/app/leads?job_id=${c.id}` : null
  const qualifiedN = sum(ready), heldN = sum(c => c.qualification.held ?? 0)
  const contactN = sum(c => c.contact?.readyWithContact ?? 0)
  // The two reads overlap (a campaign's drafts are also in the emails read), so they are never added together. A complete
  // emails read is the whole count; a capped one gives at least the larger of the two.
  const campDrafts = sum(c => c.outreach ? c.outreach.drafts + c.outreach.approved + c.outreach.sent : 0)
  const msgDrafts = msgs ? msgs.filter(m => m.status !== 'skipped').length : 0
  const draftN = msgsComplete ? msgDrafts : Math.max(msgDrafts, campDrafts)
  const draftAtLeast = !msgsComplete
  const campGap = !camps ? 'could not check - your searches\' results did not load' : `could not check - only your latest ${CAMPAIGNS_CAP} searches could be checked`
  const noSearchYet = finishedN === 0
  // Qualified: point at held or to-review leads first (something to act on), else the newest finished search.
  const reviewCamp = first(c => (c.qualification.held ?? 0) + (c.qualification.needsReview ?? 0) > 0) ?? first(c => c.status === 'done')
  const qualified: ReadyItem = qualifiedN > 0 ? { id: 'qualified', label: 'Qualified lead', state: 'done', detail: `${qualifiedN} source-checked or confirmed by you`, fix: null }
    : !campsComplete ? unknown('qualified', 'Qualified lead', campGap)
    : { id: 'qualified', label: 'Qualified lead', state: 'todo', detail: noSearchYet ? 'comes from your first search' : heldN > 0 ? `${heldN} checked lead${heldN === 1 ? ' waits for its' : 's wait for their'} event date to be confirmed` : 'no lead has passed the source check yet', fix: noSearchYet || !reviewCamp ? null : { href: href(reviewCamp)!, label: 'Review leads' } }
  const contactCamp = first(c => ready(c) > 0)
  const contact: ReadyItem = contactN > 0 ? { id: 'contact', label: 'Contact found', state: 'done', detail: `${contactN} qualified lead${contactN === 1 ? '' : 's'} with a contact`, fix: null }
    : !campsComplete ? unknown('contact', 'Contact found', campGap)
    : { id: 'contact', label: 'Contact found', state: 'todo', detail: qualifiedN > 0 ? 'none of your qualified leads has a contact yet' : 'comes after a qualified lead', fix: contactCamp ? { href: href(contactCamp)!, label: 'Find contact' } : null }
  const draftCamp = first(c => (c.contact?.draftable ?? 0) > 0)
  const draft: ReadyItem = draftN > 0 ? { id: 'draft', label: 'First draft', state: 'done', detail: `${draftAtLeast ? 'at least ' : ''}${draftN} email${draftN === 1 ? '' : 's'} drafted`, fix: null }
    : !campsComplete || !msgs || !msgsComplete ? unknown('draft', 'First draft', !msgs ? 'could not check - your emails did not load' : campsComplete ? `could not check - only your latest ${MESSAGES_CAP} emails could be checked` : campGap)
    : { id: 'draft', label: 'First draft', state: 'todo', detail: draftCamp ? 'approve a qualified lead with a contact and dazl drafts the email' : contactN > 0 ? 'a draft check is holding your leads with a contact; open one to see why' : 'comes after a qualified lead with a contact', fix: draftCamp ? { href: href(draftCamp)!, label: 'Review leads' } : contactN > 0 ? { href: href(first(c => (c.contact?.readyWithContact ?? 0) > 0))!, label: 'See why' } : null }

  // 7. Sender setup: Gmail connected, and the sender name and mailing address every email carries.
  const senderItem: ReadyItem = gmail.state === 'unknown' || sender.state === 'unknown' ? unknown('sender', 'Sender setup', gmail.state === 'unknown' ? gmail.detail : sender.detail)
    : gmail.state === 'todo' ? { id: 'sender', label: 'Sender setup', state: 'todo', detail: `Gmail ${gmail.detail}`, fix: { href: GMAIL_FIX, label: gmail.fix?.label ?? 'Connect' } }
    : sender.state === 'todo' ? { id: 'sender', label: 'Sender setup', state: 'todo', detail: `${gmail.detail}; your sender name and mailing address are missing`, fix: { href: GMAIL_FIX, label: 'Add sender details' } }
    : { id: 'sender', label: 'Sender setup', state: 'done', detail: `${gmail.detail}, as ${sender.detail}`, fix: null }

  const items = [profile, search, play, qualified, contact, draft, senderItem]
  const n = items.find(x => x.state === 'todo' && x.fix)
  if (n) n.next = true
  return items
}

// The card is shown until every step is done (a "could not check" step keeps it up).
export const readyComplete = (items: ReadyItem[]) => items.every(x => x.state === 'done')

const host = (w: string) => w.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
