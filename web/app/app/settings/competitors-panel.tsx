'use client'
import { useEffect, useState } from 'react'

// Up to 5 competitors. dazl searches public Reddit posts for recent complaints about them
// (needs the Reddit channel's consent, same as the other session channels) and shows
// matching posts as scan candidates with a "complained about <name>" badge.
export default function CompetitorsPanel() {
  const [list, setList] = useState<string[]>([])
  const [text, setText] = useState('')
  const [msg, setMsg] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void fetch('/api/settings/competitors').then(r => (r.ok ? r.json() : null)).then(j => {
      if (j) { setList(j.competitors); setText(j.competitors.join('\n')) }
      setLoaded(true)
    })
  }, [])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setMsg('')
    const competitors = text.split('\n').map(s => s.trim()).filter(Boolean)
    const r = await fetch('/api/settings/competitors', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ competitors }) })
    const j = await r.json().catch(() => null)
    if (r.ok) { setList(j.competitors); setMsg(j.competitors.length ? 'Saved. Complaint search runs on your next scan.' : 'Saved. Competitor complaint search is off.') }
    else setMsg(j?.error || 'Could not save')
  }

  if (!loaded) return null
  return (
    <div id="competitors" className="card p-6 mb-4 scroll-mt-6">
      <h2 className="font-semibold mb-1">Competitors</h2>
      <p className="text-[#555] text-sm mb-4">
        Up to 5. dazl watches public Reddit posts for recent complaints about them (&quot;name complaint OR alternative OR hate OR cancel&quot;)
        and shows matching posts in your scans with a &quot;complained about&quot; badge. Public posts only; needs the Reddit channel consent below; nothing is ever sent.
      </p>
      <form onSubmit={save}>
        <textarea
          className="input w-full mb-3"
          rows={4}
          placeholder={'One competitor per line\ne.g. Salesforce\nHubSpot'}
          value={text}
          onChange={e => setText(e.target.value)}
        />
        <button className="btn-primary" type="submit">Save competitors</button>
        {msg && <p className="text-sm text-[#555] mt-3">{msg}</p>}
      </form>
    </div>
  )
}
