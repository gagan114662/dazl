'use client'
import { useEffect, useState } from 'react'
import { draftFirstDegreeMessage, draftIntroRequest } from '@/lib/warm/draft'

// Warm paths: first-degree connections from the user's OWN imported LinkedIn
// connections export, plus mutuals the user saw and reported by hand. dazl never
// scrapes LinkedIn, never syncs contacts, and never claims a path it cannot ground.
// Second-degree detection is NOT claimed anywhere: the import proves first degree,
// everything else is user-reported or a manual check link.

type FirstDegree = { contact_name: string; contact_title: string | null; linkedin_url: string; connection_name: string; connection_position: string | null; connection_company: string | null }
type ManualCheck = { contact_name: string; contact_title: string | null; linkedin_url: string }
type UserPath = { id: string; contact_url: string; mutual_name: string; note: string | null; created_at: number }
type Warm = { first_degree: FirstDegree[]; manual_check: ManualCheck[]; user_reported: UserPath[]; imported_connections: number }

export function WarmConnections() {
  const [status, setStatus] = useState<{ count: number; imported_at: number | null } | null>(null)
  const [note, setNote] = useState('')
  const [pending, setPending] = useState<{ csv: string; existing: number } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = () => fetch('/api/warm/connections').then(r => r.json()).then(setStatus).catch(() => {})
  useEffect(() => { void load() }, [])

  async function upload(csv: string, confirm: boolean) {
    setBusy(true)
    try {
      const r = await fetch('/api/warm/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csv, confirm_replace: confirm }) })
      const j = await r.json()
      if (r.status === 409 && j.error === 'replace_needs_confirm') { setPending({ csv, existing: j.existing_count }); setNote('') }
      else if (!r.ok) setNote(j.error === 'csv_too_large' ? 'That file is too large.' : j.error === 'no_valid_rows' ? 'No connection rows found - export Connections.csv from LinkedIn (Settings - Data privacy - Get a copy of your data).' : 'Could not import the file.')
      else {
        setPending(null)
        setNote(`${j.imported} connection${j.imported === 1 ? '' : 's'} imported${j.replaced ? `, replacing ${j.replaced}` : ''}${j.skipped ? ` (${j.skipped} row${j.skipped === 1 ? '' : 's'} skipped - no profile link)` : ''}${j.capped ? ` - file capped at ${j.max_rows} rows` : ''}. Your own reported paths were kept.`)
        void load()
      }
    } finally { setBusy(false) }
  }

  async function remove() {
    if (!confirm('Delete all imported connections? Your own reported paths are kept.')) return
    const r = await fetch('/api/warm/connections', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })
    if (r.ok) { setNote('Imported connections deleted.'); void load() }
  }

  return (
    <details className="text-sm text-gray-400 mb-4" id="warm-connections">
      <summary className="cursor-pointer">Warm paths - people you already know at a lead</summary>
      <div className="mt-2 ml-4 text-xs space-y-2">
        <p>Export your LinkedIn connections (LinkedIn - Settings - Data privacy - Get a copy of your data - Connections.csv) and choose the file here. This proves <span className="text-[#111]">first-degree</span> connections only. Nothing is fetched, scraped or synced - the file you choose is the only source, and you can delete it any time.</p>
        <div className="flex items-center gap-3">
          <input type="file" accept=".csv,text/csv" disabled={busy} onChange={e => { const f = e.target.files?.[0]; if (!f) return; void f.text().then(t => upload(t, false)); e.target.value = '' }} className="text-xs" />
          {status && status.count > 0 && <button className="underline text-gray-500" onClick={() => void remove()}>Delete import</button>}
        </div>
        {status && status.count > 0 && <p className="text-gray-500">{status.count} connections imported{status.imported_at ? ` on ${new Date(status.imported_at * 1000).toLocaleDateString()}` : ''}.</p>}
        {pending && (
          <div className="border border-yellow-500/30 p-2">
            <p className="text-yellow-500">This replaces your current {pending.existing} imported connections. Your own reported paths are kept.</p>
            <div className="flex gap-3 mt-1">
              <button className="underline text-[#111]" disabled={busy} onClick={() => void upload(pending.csv, true)}>Replace {pending.existing} connections</button>
              <button className="underline text-gray-500" onClick={() => setPending(null)}>Cancel</button>
            </div>
          </div>
        )}
        {note && <p className="text-gray-500">{note}</p>}
      </div>
    </details>
  )
}

export function WarmPath({ leadId, company = '', signal = '' }: { leadId: string; company?: string; signal?: string }) {
  const [warm, setWarm] = useState<Warm | null>(null)
  const [mutual, setMutual] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [draftFor, setDraftFor] = useState<string | null>(null)

  const load = () => fetch(`/api/leads/${leadId}/warm-path`).then(async r => { if (r.ok) setWarm(await r.json()); else setNote('Could not load warm paths.') }).catch(() => setNote('Could not load warm paths.'))

  async function add(contactUrl: string) {
    const name = (mutual[contactUrl] ?? '').trim()
    if (!name) return
    const r = await fetch(`/api/leads/${leadId}/warm-path`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contact_url: contactUrl, mutual_name: name }) })
    if (r.ok) { setMutual({ ...mutual, [contactUrl]: '' }); void load() } else setNote('Could not save that.')
  }

  const contactNameFor = (url: string): string => {
    const all = [...(warm?.first_degree ?? []), ...(warm?.manual_check ?? [])]
    return all.find(c => c.linkedin_url === url)?.contact_name ?? ''
  }

  async function removePath(id: string) {
    const r = await fetch(`/api/leads/${leadId}/warm-path`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    if (r.ok) void load()
  }

  return (
    <details className="text-xs mt-1" onToggle={e => { if ((e.target as HTMLDetailsElement).open && !warm) void load() }}>
      <summary className="cursor-pointer text-gray-500">Warm paths</summary>
      <div className="ml-4 mt-1 space-y-1">
        {!warm && <p className="text-gray-500">Loading...</p>}
        {warm && warm.first_degree.length === 0 && warm.user_reported.length === 0 && warm.manual_check.length === 0 && (
          <p className="text-gray-500">{warm.imported_connections === 0 ? 'No connections imported yet - import your LinkedIn connections above to find people you already know here.' : 'No contacts with LinkedIn profiles on this lead yet.'}</p>
        )}
        {warm && warm.first_degree.map(f => (
          <div key={f.linkedin_url} className="border border-green-500/30 p-2">
            <span className="text-green-300">First degree:</span> you are connected to <span className="text-[#111]">{f.connection_name}</span>{f.connection_position ? ` (${f.connection_position}${f.connection_company ? ` at ${f.connection_company}` : ''})` : ''} - matches {f.contact_name}{f.contact_title ? `, ${f.contact_title}` : ''} here. From your imported connections.{' '}
            <a className="underline text-[#111]" href={f.linkedin_url} target="_blank" rel="noopener noreferrer nofollow">profile</a>
            <div className="text-gray-500 mt-1">Consider a personal LinkedIn message before a cold email - dazl does not send it for you.</div>
            <button className="underline text-gray-500 mt-1" onClick={() => setDraftFor(draftFor === f.linkedin_url ? null : f.linkedin_url)}>{draftFor === f.linkedin_url ? 'hide draft' : 'draft a message'}</button>
            {draftFor === f.linkedin_url && (
              <div className="mt-1">
                <textarea readOnly className="w-full border border-white/10 bg-transparent p-1 text-xs" rows={6} value={draftFirstDegreeMessage({ connectionName: f.connection_name, company, signal })} />
                <p className="text-gray-500">A starting draft only - review, edit, fill the bracketed line, then copy and send it yourself on LinkedIn. dazl does not send messages, and nothing here claims any past conversation.</p>
              </div>
            )}
          </div>
        ))}
        {warm && warm.user_reported.map(u => (
          <div key={u.id} className="text-gray-400">
            <span className="text-yellow-500">Reported by you, not verified:</span> {u.mutual_name} knows{' '}
            <a className="underline text-[#111]" href={u.contact_url} target="_blank" rel="noopener noreferrer nofollow">this contact</a>{u.note ? ` - ${u.note}` : ''}{' '}
            <button className="underline text-gray-500" onClick={() => void removePath(u.id)}>remove</button>{' '}
            <button className="underline text-gray-500" onClick={() => setDraftFor(draftFor === u.id ? null : u.id)}>{draftFor === u.id ? 'hide draft' : 'draft an intro request'}</button>
            {draftFor === u.id && (
              <div className="mt-1">
                <textarea readOnly className="w-full border border-white/10 bg-transparent p-1 text-xs" rows={6} value={draftIntroRequest({ mutualName: u.mutual_name, contactName: contactNameFor(u.contact_url), company })} />
                <p className="text-gray-500">A starting draft only - based on a mutual YOU reported, not a verified connection. Review, edit, fill the bracketed line, then copy and send it yourself. dazl does not send messages.</p>
              </div>
            )}
          </div>
        ))}
        {warm && warm.manual_check.map(c => (
          <div key={c.linkedin_url} className="text-gray-400">
            {c.contact_name}{c.contact_title ? ` - ${c.contact_title}` : ''}:{' '}
            <a className="underline text-[#111]" href={c.linkedin_url} target="_blank" rel="noopener noreferrer nofollow">check mutuals on LinkedIn</a>
            <span className="text-gray-500"> (dazl cannot see second-degree connections)</span>
            <span className="inline-flex gap-1 ml-2">
              <input className="border border-white/10 bg-transparent px-1 py-0.5 text-xs w-36" placeholder="I see a mutual - name" value={mutual[c.linkedin_url] ?? ''} onChange={e => setMutual({ ...mutual, [c.linkedin_url]: e.target.value })} />
              <button className="underline text-[#111]" onClick={() => void add(c.linkedin_url)}>save</button>
            </span>
          </div>
        ))}
        {note && <p className="text-gray-500">{note}</p>}
      </div>
    </details>
  )
}
