'use client'
import { useEffect, useState } from 'react'

// Up to 5 competitors. dazl searches public Reddit posts for recent complaints about them
// (needs the Reddit channel's consent, same as the other session channels) and shows
// matching posts as scan candidates with a "complained about <name>" badge. Each competitor
// may also carry its LinkedIn page (#1588): when dazl Connect is paired, the user's own
// browser reads that page's recent posts and the people engaging with them become leads.
export default function CompetitorsPanel() {

  const [rows, setRows] = useState<{ name: string; page: string }[]>([{ name: '', page: '' }])
  const [msg, setMsg] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [connect, setConnect] = useState(false)
  // A list that could not be read is never shown as an empty form (saving that would wipe the stored list, #1043 council).
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    void fetch('/api/settings/competitors').then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then(j => {
      if (!Array.isArray(j?.competitors) || typeof j?.connect !== 'boolean') throw new Error('shape')
      const pages = new Map<string, string>((Array.isArray(j.pages) ? j.pages : []).map((p: { name: string; page_url: string }) => [p.name, p.page_url] as [string, string]))
      const list = (j.competitors as string[]).map(name => ({ name, page: pages.get(name) ?? '' }))
      setRows(list.length ? list : [{ name: '', page: '' }])
      setConnect(j.connect)
      setLoaded(true)
    }).catch(() => setFailed(true))
  }, [])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setMsg('')
    const filled = rows.map(r => ({ name: r.name.trim(), page: r.page.trim() })).filter(r => r.name)
    const competitors = filled.map(r => r.page ? { name: r.name, page_url: r.page } : r.name)
    const r = await fetch('/api/settings/competitors', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ competitors }) })
    const j = await r.json().catch(() => null)
    if (r.ok) {
      const withPages = (j?.pages?.length ?? 0) > 0
      setMsg(!j.competitors.length ? 'Saved. Competitor complaint search is off.'
        : withPages && !connect ? 'Saved. Connect dazl\u2019s LinkedIn Reader below to also watch your competitors\u2019 LinkedIn posts.'
        : withPages ? 'Saved. Complaint search runs on your next scan; your competitors\u2019 LinkedIn posts are read by dazl Connect.'
        : 'Saved. Complaint search runs on your next scan.')
    }
    else setMsg(j?.error || 'Could not save')
  }

  if (failed) return <div id="competitors" className="card p-6 mb-4 scroll-mt-6"><h2 className="font-semibold mb-1">Competitors</h2><p className="text-sm" role="alert" data-testid="competitors-unread">Could not load your competitors, so they cannot be edited right now. Refresh to retry.</p></div>
  if (!loaded) return null
  return (
    <div id="competitors" className="card p-6 mb-4 scroll-mt-6">
      <h2 className="font-semibold mb-1">Competitors</h2>
      <p className="text-[#555] text-sm mb-4">
        Up to 5. dazl watches public Reddit posts for recent complaints about them (&quot;name complaint OR alternative OR hate OR cancel&quot;)
        and shows matching posts in your scans with a &quot;complained about&quot; badge. Give one its LinkedIn page and, with dazl Connect
        paired, the people engaging with that competitor&apos;s own recent LinkedIn posts become leads too — read in your browser,
        working hours only. Public pages only; nothing is ever sent.
      </p>
      <form onSubmit={save}>
        <div className="mb-3">
          {rows.map((row, i) => (
            <div key={i} className="flex flex-col gap-2 sm:flex-row sm:items-center mb-2">
              <input
                className="input sm:flex-1"
                placeholder={i === 0 ? 'Competitor name' : 'Name'}
                value={row.name}
                data-testid={`competitor-name-${i}`}
                onChange={e => setRows(rows.map((r, j) => j === i ? { ...r, name: e.target.value } : r))}
              />
              <input
                className="input sm:flex-1"
                placeholder="Its LinkedIn page, optional (https://www.linkedin.com/company/...)"
                value={row.page}
                data-testid={`competitor-page-${i}`}
                onChange={e => setRows(rows.map((r, j) => j === i ? { ...r, page: e.target.value } : r))}
              />
            </div>
          ))}
        </div>
        <div className="flex gap-2 items-center mb-3">
          <button className="btn-primary" type="submit">Save competitors</button>
          {rows.length < 5 && <button type="button" className="btn-ghost" data-testid="competitor-add" onClick={() => setRows([...rows, { name: '', page: '' }])}>Add another</button>}
        </div>
        {msg && <p className="text-sm text-[#555] mt-3" data-testid="competitors-msg">{msg}</p>}
      </form>
    </div>
  )
}
