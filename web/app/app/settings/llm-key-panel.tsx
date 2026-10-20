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

  const field = 'bg-white/10 border border-white/20 rounded-xl px-4 py-2.5 text-white text-sm'
  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-6 mb-4">
      <h2 className="font-semibold mb-1">AI provider key</h2>
      <p className="text-gray-400 text-sm mb-4">Scans use your own Anthropic or OpenAI key, so usage is billed to you by the provider. Your key is encrypted and never shown again.</p>
      {keys.map(k => (
        <div key={k.vendor} className="flex items-center justify-between text-sm mb-3">
          <span>{k.vendor === 'anthropic' ? 'Anthropic' : 'OpenAI'} key ending in {k.last4}</span>
          <button onClick={() => remove(k.vendor)} className="text-red-400 hover:text-red-300">Remove</button>
        </div>
      ))}
      <form onSubmit={save} className="flex flex-col gap-3" autoComplete="off">
        <select className={field} value={vendor} onChange={e => setVendor(e.target.value as Vendor)}>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
        <input className={field} type="password" autoComplete="off" placeholder="Paste your API key" value={apiKey} onChange={e => setApiKey(e.target.value)} />
        <button className="bg-indigo-500 hover:bg-indigo-400 px-5 py-2 rounded-xl text-sm font-medium transition w-fit">Save key</button>
        {msg && <p className="text-sm text-gray-400">{msg}</p>}
      </form>
    </div>
  )
}
