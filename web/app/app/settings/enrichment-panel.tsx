'use client'
import { useEffect, useState } from 'react'

interface Slot { connector: string; last4: string; enabled: boolean }
interface AuditRow { connector: string; scan_job_id: string | null; lookup: string; status: string; results: number; created_at: number }

const SLOTS = [
  { id: 'enrich:apollo', name: 'Apollo.io', hint: 'api.apollo.io key. Organization lookups can charge Apollo credits (documented 1 credit each on current plans, capped at 5 companies per scan; older plans can differ - the cost on your account is not verified). Apollo documents people search as 0 credits on current plans (older plans can differ); it returns names and titles, not emails.' },
  { id: 'enrich:pdl', name: 'People Data Labs', hint: 'api key. Used only when no Apollo key is saved - unless you turn on the fallback below. Person search can use your PDL credits per profile returned. Your plan determines available credits and billing, and the cost on your account is not verified.' },
]

export default function EnrichmentPanel() {
  const [data, setData] = useState<{ connectors: Slot[]; audit: AuditRow[]; fallback?: boolean } | null>(null)
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState('')
  async function load() { const r = await fetch('/api/settings/enrichment'); if (r.ok) setData(await r.json()) }
  useEffect(() => { void load() }, [])
  async function act(body: Record<string, unknown>) {
    const r = await fetch('/api/settings/enrichment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    setMsg(r.ok ? (body.disconnect ? 'Removed.' : 'Saved.') : j.error || 'Something went wrong')
    setKeys({})
    void load()
  }
  if (!data) return null
  const byId = Object.fromEntries(data.connectors.map(c => [c.connector, c]))
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">Enrichment (bring your own key)</h2>
      <p className="text-[#555] text-sm mb-3">
        Add your own Apollo.io or People Data Labs key and every scan enriches the companies it finds with firmographics and named contacts.
        Your key is stored encrypted, never shown again, and only your account&apos;s scans spend your credits. Without a key nothing calls these services.
      </p>
      <div className="space-y-4">
        {SLOTS.map(s => {
          const st = byId[s.id]
          return (
            <div key={s.id} className="text-sm">
              <div className="font-medium">{s.name}</div>
              <p className="text-[#777] text-xs mb-1">{s.hint}</p>
              {st?.enabled ? (
                <div className="flex items-center gap-3">
                  <span>Connected (key ending {st.last4})</span>
                  <button className="underline underline-offset-2" onClick={() => act({ connector: s.id, disconnect: true })}>Remove</button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <input className="field flex-1" type="password" placeholder={`Paste your ${s.name} API key`} value={keys[s.id] ?? ''} onChange={e => setKeys({ ...keys, [s.id]: e.target.value })} />
                  <button className="btn-primary" disabled={!(keys[s.id] ?? '').trim()} onClick={() => act({ connector: s.id, key: (keys[s.id] ?? '').trim() })}>Save</button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {byId['enrich:apollo']?.enabled && byId['enrich:pdl']?.enabled && (
        <label className="flex items-start gap-2 text-sm mt-1">
          <input type="checkbox" className="mt-0.5" checked={!!data.fallback} onChange={e => act({ fallback: e.target.checked })} />
          <span>
            Also use People Data Labs as a fallback when Apollo finds no contacts for a company.
            <span className="text-[#777] text-xs block">Off by default. Each fallback profile returned can use 1 PDL credit (up to 5 per scan - documented terms; the cost on your account is not verified).</span>
          </span>
        </label>
      )}
      {data.audit.length > 0 && (
        <div className="mt-4 text-xs text-[#555]">
          <div className="font-medium text-sm mb-1">Recent enrichment lookups</div>
          {data.audit.slice(0, 8).map((a, i) => (
            <div key={i} className="flex gap-2">
              <span>{new Date(a.created_at * 1000).toLocaleDateString()}</span>
              <span className="font-mono">{a.connector.replace('enrich:', '')}</span>
              <span className="truncate flex-1">{a.lookup}</span>
              <span>{a.status}{a.results ? ` · ${a.results}` : ''}</span>
            </div>
          ))}
        </div>
      )}
      {msg && <p className="text-sm text-[#555] mt-2">{msg}</p>}
    </div>
  )
}
