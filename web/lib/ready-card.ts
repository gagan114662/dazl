import { readinessRows, type ReadinessInput, type Row } from './readiness.ts'
import { coreSources, socialSources } from './scan/source-availability.ts'

// Home's "ready to run" card: the four things a play needs to run well (website and brain, AI key, Gmail, lead
// sources), read from the same rows as the full setup checklist (lib/readiness.ts), so the two never disagree. Pure and
// client-safe. Each missing item has one link that goes straight to its fix; a row that could not be checked says so
// and offers no fix. Sources are named only when a scan here can really use them.

export type ReadyId = 'brain' | 'key' | 'gmail' | 'sources'
export interface ReadyItem { id: ReadyId; label: string; state: Row['state']; detail: string; fix: { href: string; label: string } | null }

const KEY_FIX = '/app/settings#model-key'

export function readyItems(i: ReadinessInput): ReadyItem[] {
  const rows = readinessRows(i)
  const row = (id: Row['id']) => rows.find(r => r.id === id)!
  const site = row('site'), brainRow = row('brain'), key = row('key'), gmail = row('gmail'), src = row('sources')

  // Website and brain together: what dazl read from your site. The website is fixed first (the brain is drafted from it).
  const p = i.profile
  const brain: ReadyItem = site.state === 'unknown' || brainRow.state === 'unknown' ? { id: 'brain', label: 'Website and brain', state: 'unknown', detail: site.detail, fix: null }
    : !p?.website ? { id: 'brain', label: 'Website and brain', state: 'todo', detail: 'add your website so dazl can read who buys from you', fix: { href: '/app?setup=site', label: 'Add website' } }
    : brainRow.state === 'todo' ? { id: 'brain', label: 'Website and brain', state: 'todo', detail: `${host(p.website)} saved; the buyer profile is not built yet`, fix: { href: '/app?setup=brain', label: 'Build brain' } }
    : { id: 'brain', label: 'Website and brain', state: 'done', detail: `${host(p.website)} - ${brainRow.detail}`, fix: null }

  const keyItem: ReadyItem = { id: 'key', label: 'AI key', state: key.state, detail: key.detail, fix: key.state === 'todo' ? { href: KEY_FIX, label: key.fix?.label ?? 'Add key' } : null }
  const gmailItem: ReadyItem = { id: 'gmail', label: 'Gmail connected', state: gmail.state, detail: gmail.detail, fix: gmail.state === 'todo' && gmail.fix?.kind === 'link' ? { href: gmail.fix.href, label: gmail.fix.label } : null }

  // Usable sources only. What cannot run is not listed here (the full checklist in Setup details explains it); when no
  // source can run, the fix is the one thing the user can do: the AI key.
  const core = coreSources(i.sources ?? null, i.usage ? { has_key: i.usage.has_key, trial: i.usage.trial } : null)
  const usable = core ? [...core, ...socialSources(i.advanced ?? null)].filter(r => r.usable).map(r => r.label) : []
  const sources: ReadyItem = src.state === 'unknown' ? { id: 'sources', label: 'Lead sources', state: 'unknown', detail: src.detail, fix: null }
    : src.state === 'todo' ? { id: 'sources', label: 'Lead sources', state: 'todo', detail: 'none can run until your AI key works', fix: { href: KEY_FIX, label: key.fix?.label ?? 'Add key' } }
    : { id: 'sources', label: 'Lead sources', state: 'done', detail: `${usable.length} available: ${usable.join(', ')}`, fix: null }
  return [brain, keyItem, gmailItem, sources]
}

// The card is shown until every item is done (a "could not check" item keeps it up).
export const readyComplete = (items: ReadyItem[]) => items.every(x => x.state === 'done')

const host = (w: string) => w.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
