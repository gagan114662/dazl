'use client'
import { useEffect, useState } from 'react'

export default function CrmPanel() {
  const [cfg, setCfg] = useState<{ configured: boolean; provider: string | null } | null>(null)
  const [provider, setProvider] = useState('hubspot')
  const [secret, setSecret] = useState('')
  const [msg, setMsg] = useState('')
  async function load() { const r = await fetch('/api/crm'); if (r.ok) setCfg(await r.json()) }
  useEffect(() => { void load() }, [])
  async function act(body: Record<string, unknown>) {
    const r = await fetch('/api/crm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    setMsg(r.ok ? (body.action === 'disconnect' ? 'Disconnected.' : 'Saved.') : j.error || 'Something went wrong')
    setSecret('')
    void load()
  }
  if (!cfg) return null
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">CRM</h2>
      <p className="text-[#555] text-sm mb-3">Push leads to your CRM with one click from the Leads page. Your key is stored encrypted and never shown again.</p>
      {cfg.configured ? (
        <div className="text-sm space-y-2">
          <div>Connected: <span className="font-medium">{cfg.provider === 'webhook' ? 'Generic webhook' : cfg.provider === 'hubspot' ? 'HubSpot' : 'Pipedrive'}</span></div>
          <button className="underline underline-offset-2" onClick={() => act({ action: 'disconnect' })}>Disconnect</button>
        </div>
      ) : (
        <div className="text-sm space-y-2">
          <div className="flex gap-4">
            <label className="flex items-center gap-1"><input type="radio" name="crm" checked={provider === 'hubspot'} onChange={() => setProvider('hubspot')} /> HubSpot</label>
            <label className="flex items-center gap-1"><input type="radio" name="crm" checked={provider === 'pipedrive'} onChange={() => setProvider('pipedrive')} /> Pipedrive</label>
            <label className="flex items-center gap-1"><input type="radio" name="crm" checked={provider === 'webhook'} onChange={() => setProvider('webhook')} /> Webhook</label>
          </div>
          {provider === 'webhook' ? (
            <input className="field w-full" type="url" placeholder="https://your-endpoint.example/dazl" value={secret} onChange={e => setSecret(e.target.value)} />
          ) : (
            <input className="field w-full" type="password" placeholder={provider === 'hubspot' ? 'Private app access token' : 'Pipedrive API token'} value={secret} onChange={e => setSecret(e.target.value)} />
          )}
          <button className="btn-primary" disabled={!secret.trim()} onClick={() => act(provider === 'webhook' ? { action: 'save', provider, url: secret.trim() } : { action: 'save', provider, key: secret.trim() })}>Connect</button>
        </div>
      )}
      {msg && <p className="text-sm text-[#555] mt-2">{msg}</p>}
    </div>
  )
}
