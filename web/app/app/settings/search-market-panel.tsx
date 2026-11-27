'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { SearchMarket } from '@/lib/scan/search-market'

export default function SearchMarketPanel() {
  const [market, setMarket] = useState<SearchMarket | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void fetch('/api/settings/search-market').then(async r => {
      if (!r.ok) throw new Error()
      setMarket(await r.json() ?? { country: null, language: null })
    }).catch(() => setMessage('Could not load the search market.'))
  }, [])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!market) return
    setBusy(true)
    setMessage('')
    try {
      const r = await fetch('/api/settings/search-market', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ country: market.country ?? '', language: market.language ?? '' }),
      })
      const body = await r.json()
      if (r.ok) setMarket(body)
      setMessage(r.ok ? 'Search market saved.' : body.error ?? 'Could not save the search market.')
    } catch {
      setMessage('Could not save the search market.')
    } finally {
      setBusy(false)
    }
  }

  return <section className="card p-6 mb-4">
    <h2 className="font-semibold mb-2">Search market</h2>
    <p className="text-sm text-[#555] mb-3">Used when your search and buyer profile leave the market open.</p>
    {market && <form onSubmit={save} className="flex flex-wrap items-end gap-3">
      <label className="text-sm">Country code <input className="field block" value={market.country ?? ''} maxLength={2} placeholder="CA" onChange={e => setMarket({ ...market, country: e.target.value })} /></label>
      <label className="text-sm">Language code <input className="field block" value={market.language ?? ''} maxLength={3} placeholder="fr" onChange={e => setMarket({ ...market, language: e.target.value })} /></label>
      <button className="btn-primary" disabled={busy}>Save search market</button>
    </form>}
    {message && <p className="text-sm mt-2" role="status">{message}</p>}
  </section>
}
