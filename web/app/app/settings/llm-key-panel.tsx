'use client'
import { useEffect, useState } from 'react'

type Vendor = 'anthropic' | 'openai'
interface Status { vendor: Vendor; last4: string }

export default function LlmKeyPanel() {
  const [keys, setKeys] = useState<Status[]>([])
  const [vendor, setVendor] = useState<Vendor>('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [msg, setMsg] = useState('')

  async function load() {
    const r = await fetch('/api/settings/llm-key')
    if (r.ok) setKeys((await r.json()).keys)
  }
  useEffect(() => { void load() }, [])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setMsg('Checking your key...')
    const r = await fetch('/api/settings/llm-key', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vendor, api_key: apiKey }) })
    const j = await r.json()
    setMsg(r.ok ? 'Key saved.' : j.error || 'Could not save the key')
    if (r.ok) { setApiKey(''); void load() }
  }

  async function remove(v: Vendor) {
    await fetch(`/api/settings/llm-key?vendor=${v}`, { method: 'DELETE' })
    void load()
  }

  const field = 'field'
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">AI provider key</h2>
      <p className="text-[#555] text-sm mb-4">Scans use your own Anthropic or OpenAI key, so usage is billed to you by the provider. Your key is encrypted and never shown again.</p>
      {keys.map(k => (
        <div key={k.vendor} className="flex items-center justify-between text-sm mb-3">
          <span>{k.vendor === 'anthropic' ? 'Anthropic' : 'OpenAI'} key ending in {k.last4}</span>
          <button onClick={() => remove(k.vendor)} className="text-[#111] underline underline-offset-2">Remove</button>
        </div>
      ))}
      <form method="post" onSubmit={save} className="flex flex-col gap-3" autoComplete="off">
        <select className={field} value={vendor} onChange={e => setVendor(e.target.value as Vendor)}>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
        <input className={field} type="password" autoComplete="off" placeholder="Paste your API key" value={apiKey} onChange={e => setApiKey(e.target.value)} />
        <button className="btn-primary w-fit">Save key</button>
        {msg && <p className="text-sm text-[#555]">{msg}</p>}
      </form>
    </div>
  )
}
